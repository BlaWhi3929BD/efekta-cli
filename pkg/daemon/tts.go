package daemon

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"
)

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

// splitTextChunks splits a sentence into chunks <= 180 chars for TTS endpoints
func splitTextChunks(text string, maxLen int) []string {
	words := strings.Fields(strings.TrimSpace(text))
	if len(words) == 0 {
		return nil
	}
	var chunks []string
	var cur strings.Builder
	for _, w := range words {
		if cur.Len() > 0 && cur.Len()+1+len(w) > maxLen {
			chunks = append(chunks, cur.String())
			cur.Reset()
		}
		if cur.Len() > 0 {
			cur.WriteByte(' ')
		}
		cur.WriteString(w)
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
	if lang == "" {
		lang = "en"
	}

	cacheKey := lang + "|" + strings.ToLower(text)
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
		// Strategy 2: gtts-cli CLI fallback
		if gttsPath, err := exec.LookPath("gtts-cli"); err == nil {
			cmd := exec.Command(gttsPath, "-l", lang, text)
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

// isPublicIP rejects loopback, private, link-local, multicast, unspecified, and CGNAT IP addresses.
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
		// Reject 0.0.0.0/8 ("this network") and 100.64.0.0/10 (CGNAT)
		if ip[0] == 0 || (ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127) {
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
			d := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
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
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")
	resp, err := remoteAudioHTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HTTP %d fetching audio", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil || len(data) == 0 {
		return nil, "", fmt.Errorf("empty audio body")
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" {
		mime = "audio/mpeg"
	}
	return data, mime, nil
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
