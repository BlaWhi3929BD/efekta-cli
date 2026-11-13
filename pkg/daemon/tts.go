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

// FetchRemoteAudio fetches reference audio bytes from an https:// media URL
func FetchRemoteAudio(rawURL string) ([]byte, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, "", fmt.Errorf("invalid audio URL: %s", rawURL)
	}
	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")
	resp, err := ipv4HTTPClient.Do(req)
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
