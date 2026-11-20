package daemon

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxTTSRunes   = 2000
	maxAudioBytes = 8 * 1024 * 1024
)

var validTTSLangRe = regexp.MustCompile(`^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$`)

type allowedProxyAddrKey struct{}

func validateTTSLang(lang string) (string, error) {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return "en", nil
	}
	if !validTTSLangRe.MatchString(lang) {
		return "", fmt.Errorf("invalid TTS language code: %q", lang)
	}
	return lang, nil
}

type ttsRequest struct {
	Text string `json:"text,omitempty"`
	Lang string `json:"lang,omitempty"`
	URL  string `json:"url,omitempty"`
}

type ttsResponse struct {
	Success     bool   `json:"success"`
	AudioBase64 string `json:"audioBase64,omitempty"`
	Mime        string `json:"mime,omitempty"`
	Source      string `json:"source,omitempty"`
	Error       string `json:"error,omitempty"`
}

var (
	ttsCacheMu sync.Mutex
	ttsCache   = make(map[string][]byte)

	ipv4HTTPClient = &http.Client{
		Timeout: 6 * time.Second,
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				d := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
				conn, err := d.DialContext(ctx, "tcp4", addr)
				if err == nil {
					return conn, nil
				}
				return d.DialContext(ctx, network, addr)
			},
		},
	}
)

// splitTextChunks splits a sentence into chunks <= maxLen runes for TTS endpoints
func splitTextChunks(text string, maxLen int) []string {
	if maxLen <= 0 {
		maxLen = 180
	}
	words := strings.Fields(strings.TrimSpace(text))
	if len(words) == 0 {
		return nil
	}
	var chunks []string
	var cur strings.Builder
	curRunes := 0
	for _, w := range words {
		wRunes := utf8.RuneCountInString(w)
		if wRunes > maxLen {
			if cur.Len() > 0 {
				chunks = append(chunks, cur.String())
				cur.Reset()
				curRunes = 0
			}
			runes := []rune(w)
			for i := 0; i < len(runes); i += maxLen {
				end := i + maxLen
				if end > len(runes) {
					end = len(runes)
				}
				chunks = append(chunks, string(runes[i:end]))
			}
			continue
		}
		if curRunes > 0 && curRunes+1+wRunes > maxLen {
			chunks = append(chunks, cur.String())
			cur.Reset()
			curRunes = 0
		}
		if curRunes > 0 {
			cur.WriteByte(' ')
			curRunes++
		}
		cur.WriteString(w)
		curRunes += wRunes
	}
	if cur.Len() > 0 {
		chunks = append(chunks, cur.String())
	}
	return chunks
}

// SynthesizeTTS generates MP3 audio bytes for an English phrase using fast IPv4 Google TTS with gtts-cli fallback.
func SynthesizeTTS(text, lang string) ([]byte, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("empty text for TTS")
	}
	if utf8.RuneCountInString(text) > maxTTSRunes {
		return nil, fmt.Errorf("TTS text exceeds maximum length (%d chars)", maxTTSRunes)
	}
	validLang, err := validateTTSLang(lang)
	if err != nil {
		return nil, err
	}
	lang = validLang

	cacheKey := strings.ToLower(lang) + "|" + strings.ToLower(text)
	ttsCacheMu.Lock()
	if cached, ok := ttsCache[cacheKey]; ok && len(cached) > 0 {
		ttsCacheMu.Unlock()
		return cached, nil
	}
	ttsCacheMu.Unlock()

	// Strategy 1: Direct IPv4 HTTP request (~300ms, zero process spawn overhead)
	chunks := splitTextChunks(text, 180)
	var combined bytes.Buffer
	directOK := len(chunks) > 0

	for _, chunk := range chunks {
		u := fmt.Sprintf(
			"https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=%s&q=%s",
			url.QueryEscape(lang),
			url.QueryEscape(chunk),
		)
		req, err := http.NewRequest(http.MethodGet, u, nil)
		if err != nil {
			directOK = false
			break
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")
		resp, err := ipv4HTTPClient.Do(req)
		if err != nil {
			directOK = false
			break
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode != http.StatusOK || len(body) < 256 {
			directOK = false
			break
		}
		combined.Write(body)
	}

	var audioBytes []byte
	if directOK && combined.Len() > 256 {
		audioBytes = combined.Bytes()
	} else {
		// Strategy 2: gtts-cli CLI fallback (bounded timeout + "--" end-of-options prevents CLI flag injection)
		if gttsPath, err := exec.LookPath("gtts-cli"); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, gttsPath, "-l", lang, "--", text)
			out, err := cmd.Output()
			if err == nil && len(out) > 256 {
				audioBytes = out
			}
		}
	}

	if len(audioBytes) == 0 {
		return nil, fmt.Errorf("failed to synthesize TTS audio for %q", text)
	}

	ttsCacheMu.Lock()
	if len(ttsCache) > 64 {
		ttsCache = make(map[string][]byte)
	}
	ttsCache[cacheKey] = audioBytes
	ttsCacheMu.Unlock()

	return audioBytes, nil
}

// isPublicIP rejects loopback, private, link-local, multicast, unspecified, CGNAT, reserved,
// documentation, benchmarking, NAT64, Teredo, 6to4, and IPv4-compatible IPv6 addresses.
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		// Reject 0.0.0.0/8, 100.64.0.0/10 (CGNAT), 192.0.0.0/24, TEST-NETs,
		// 198.18.0.0/15 (benchmarking), and 240.0.0.0/4 (reserved + 255.255.255.255 broadcast).
		if ip4[0] == 0 ||
			(ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127) ||
			(ip4[0] == 192 && ip4[1] == 0 && (ip4[2] == 0 || ip4[2] == 2)) ||
			(ip4[0] == 198 && (ip4[1] == 18 || ip4[1] == 19)) ||
			(ip4[0] == 198 && ip4[1] == 51 && ip4[2] == 100) ||
			(ip4[0] == 203 && ip4[1] == 0 && ip4[2] == 113) ||
			ip4[0] >= 240 {
			return false
		}
		ip = ip4
	} else if ip16 := ip.To16(); ip16 != nil {
		// Reject IPv4-compatible IPv6 (::/96, e.g. ::127.0.0.1)
		allZeroPrefix := true
		for i := 0; i < 12; i++ {
			if ip16[i] != 0 {
				allZeroPrefix = false
				break
			}
		}
		if allZeroPrefix {
			return false
		}
		// Reject IPv4-translated ::ffff:0:0:0/96
		if ip16[0] == 0 && ip16[1] == 0 && ip16[2] == 0 && ip16[3] == 0 &&
			ip16[4] == 0 && ip16[5] == 0 && ip16[6] == 0 && ip16[7] == 0 &&
			ip16[8] == 0xff && ip16[9] == 0xff && ip16[10] == 0 && ip16[11] == 0 {
			return false
		}
		// Reject NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
		if ip16[0] == 0x00 && ip16[1] == 0x64 && ip16[2] == 0xff && ip16[3] == 0x9b {
			if ip16[4] == 0 && ip16[5] == 0 && ip16[6] == 0 && ip16[7] == 0 &&
				ip16[8] == 0 && ip16[9] == 0 && ip16[10] == 0 && ip16[11] == 0 {
				return false
			}
			if ip16[4] == 0x00 && ip16[5] == 0x01 {
				return false
			}
		}
		// Reject discard-only 100::/64
		if ip16[0] == 0x01 && ip16[1] == 0x00 && ip16[2] == 0 && ip16[3] == 0 &&
			ip16[4] == 0 && ip16[5] == 0 && ip16[6] == 0 && ip16[7] == 0 {
			return false
		}
		// Reject IETF protocol assignments 2001::/23 (includes Teredo 2001::/32)
		if ip16[0] == 0x20 && ip16[1] == 0x01 && ip16[2] == 0x00 && (ip16[3]&0xfe) == 0 {
			return false
		}
		// Reject documentation 2001:db8::/32
		if ip16[0] == 0x20 && ip16[1] == 0x01 && ip16[2] == 0x0d && ip16[3] == 0xb8 {
			return false
		}
		// Reject 6to4 2002::/16 (embeds arbitrary IPv4 addresses)
		if ip16[0] == 0x20 && ip16[1] == 0x02 {
			return false
		}
		// Reject deprecated site-local fec0::/10
		if ip16[0] == 0xfe && (ip16[1]&0xc0) == 0xc0 {
			return false
		}
	}
	return !ip.IsLoopback() &&
		!ip.IsPrivate() &&
		!ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast() &&
		!ip.IsMulticast() &&
		!ip.IsUnspecified() &&
		!ip.IsInterfaceLocalMulticast()
}

func proxyHostPort(proxyURL *url.URL) string {
	if proxyURL == nil {
		return ""
	}
	host := proxyURL.Hostname()
	if host == "" {
		return ""
	}
	port := proxyURL.Port()
	if port == "" {
		switch strings.ToLower(proxyURL.Scheme) {
		case "https":
			port = "443"
		case "socks5", "socks5h":
			port = "1080"
		default:
			port = "80"
		}
	}
	return net.JoinHostPort(host, port)
}

func isAllowedAudioResponse(rawURL, contentType string) bool {
	mediaType := ""
	if ct := strings.TrimSpace(contentType); ct != "" {
		if parsed, _, err := mime.ParseMediaType(ct); err == nil {
			mediaType = strings.ToLower(parsed)
		} else {
			mediaType = strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
		}
	}

	if strings.HasPrefix(mediaType, "audio/") ||
		mediaType == "application/ogg" ||
		mediaType == "video/mp4" ||
		mediaType == "video/webm" {
		return true
	}

	if mediaType == "" || mediaType == "application/octet-stream" || mediaType == "binary/octet-stream" {
		if parsed, err := url.Parse(rawURL); err == nil {
			switch strings.ToLower(path.Ext(parsed.Path)) {
			case ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".weba", ".flac":
				return true
			}
		}
	}
	return false
}

func validateRemoteAudioURL(ctx context.Context, rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil {
		return nil, fmt.Errorf("invalid or insecure audio URL (https required): %s", rawURL)
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "" ||
		host == "localhost" ||
		strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") ||
		strings.HasSuffix(host, ".home.arpa") {
		return nil, fmt.Errorf("blocked unsafe audio host: %s", host)
	}

	if ip := net.ParseIP(host); ip != nil {
		if !isPublicIP(ip) {
			return nil, fmt.Errorf("blocked non-public audio IP: %s", host)
		}
		return parsed, nil
	}

	proxyURL, _ := http.ProxyFromEnvironment(&http.Request{URL: parsed})
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		if proxyURL != nil {
			// Corporate HTTPS proxy handles external DNS resolution
			return parsed, nil
		}
		return nil, fmt.Errorf("failed to resolve audio host %s: %w", host, err)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no IP addresses resolved for audio host %s", host)
	}
	for _, addr := range ips {
		if !isPublicIP(addr.IP) {
			return nil, fmt.Errorf("blocked non-public resolved IP %s for host %s", addr.IP.String(), host)
		}
	}
	return parsed, nil
}

var remoteAudioHTTPClient = &http.Client{
	Timeout: 6 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("stopped after 3 redirects")
		}
		_, err := validateRemoteAudioURL(req.Context(), req.URL.String())
		return err
	},
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			d := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
			if allowedProxy, _ := ctx.Value(allowedProxyAddrKey{}).(string); allowedProxy != "" && strings.EqualFold(addr, allowedProxy) {
				return d.DialContext(ctx, network, addr)
			}
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			var candidates []net.IP
			if ip := net.ParseIP(host); ip != nil {
				if !isPublicIP(ip) {
					return nil, fmt.Errorf("SSRF blocked: non-public IP %s", ip.String())
				}
				candidates = []net.IP{ip}
			} else {
				addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
				if err != nil {
					return nil, err
				}
				var v4, v6 []net.IP
				for _, a := range addrs {
					if !isPublicIP(a.IP) {
						return nil, fmt.Errorf("SSRF blocked: non-public resolved IP %s", a.IP.String())
					}
					if a.IP.To4() != nil {
						v4 = append(v4, a.IP)
					} else {
						v6 = append(v6, a.IP)
					}
				}
				candidates = append(v4, v6...)
			}
			if len(candidates) == 0 {
				return nil, fmt.Errorf("no routable public IP for %s", host)
			}
			var lastErr error
			for _, ip := range candidates {
				conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	},
}

// FetchRemoteAudio fetches reference audio bytes from a validated public https:// media URL
func FetchRemoteAudio(rawURL string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	parsed, err := validateRemoteAudioURL(ctx, rawURL)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", err
	}
	if proxyURL, err := http.ProxyFromEnvironment(req); err == nil && proxyURL != nil {
		if pAddr := proxyHostPort(proxyURL); pAddr != "" {
			req = req.WithContext(context.WithValue(req.Context(), allowedProxyAddrKey{}, pAddr))
		}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")
	resp, err := remoteAudioHTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HTTP %d fetching audio", resp.StatusCode)
	}
	finalURL := parsed.String()
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	ct := resp.Header.Get("Content-Type")
	if !isAllowedAudioResponse(finalURL, ct) {
		return nil, "", fmt.Errorf("blocked non-audio content type %q", ct)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAudioBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("failed reading audio body: %w", err)
	}
	if len(data) == 0 {
		return nil, "", fmt.Errorf("empty audio body")
	}
	if len(data) > maxAudioBytes {
		return nil, "", fmt.Errorf("audio body exceeds %d byte limit", maxAudioBytes)
	}
	mimeType := ct
	if mimeType == "" {
		mimeType = "audio/mpeg"
	}
	return data, mimeType, nil
}

func (s *Server) handleTTS(w http.ResponseWriter, r *http.Request) {
	if !IsAllowedHost(r.Host) {
		http.Error(w, "Forbidden host", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Allow both CLI (no Origin + X-Efekta-Client) and browser extension (moz-extension:// / chrome-extension://)
	origin := r.Header.Get("Origin")
	if !IsAllowedWSOrigin(origin) || r.Header.Get(ClientHeader) != ClientValue {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	var req ttsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ttsResponse{Success: false, Error: err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if req.URL != "" {
		data, mime, err := FetchRemoteAudio(req.URL)
		if err != nil {
			_ = json.NewEncoder(w).Encode(ttsResponse{Success: false, Error: err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(ttsResponse{
			Success:     true,
			AudioBase64: base64.StdEncoding.EncodeToString(data),
			Mime:        mime,
			Source:      "reference-url",
		})
		return
	}

	audioBytes, err := SynthesizeTTS(req.Text, req.Lang)
	if err != nil {
		_ = json.NewEncoder(w).Encode(ttsResponse{Success: false, Error: err.Error()})
		return
	}

	_ = json.NewEncoder(w).Encode(ttsResponse{
		Success:     true,
		AudioBase64: base64.StdEncoding.EncodeToString(audioBytes),
		Mime:        "audio/mpeg",
		Source:      "tts",
	})
}
