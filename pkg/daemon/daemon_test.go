package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"efekta-cli/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestIsAllowedWSOrigin(t *testing.T) {
	allowed := []string{
		"",
		"chrome-extension://abcdefghijklmnop",
		"moz-extension://12345678-1234-1234-1234-1234567890ab",
		"safari-web-extension://abcdef",
	}
	for _, orig := range allowed {
		if !IsAllowedWSOrigin(orig) {
			t.Errorf("expected origin %q to be allowed", orig)
		}
	}

	blocked := []string{
		"https://evil.com",
		"http://localhost:3000",
		"http://127.0.0.1:8080",
		"null",
	}
	for _, orig := range blocked {
		if IsAllowedWSOrigin(orig) {
			t.Errorf("expected origin %q to be blocked", orig)
		}
	}
}

func TestIsAllowedAPIRequest(t *testing.T) {
	// Valid CLI request
	reqValid := httptest.NewRequest(http.MethodPost, "/api/exec", nil)
	reqValid.Header.Set(ClientHeader, ClientValue)
	if !IsAllowedAPIRequest(reqValid) {
		t.Fatal("expected valid CLI request to be allowed")
	}

	// Missing X-Efekta-Client header
	reqNoHeader := httptest.NewRequest(http.MethodPost, "/api/exec", nil)
	if IsAllowedAPIRequest(reqNoHeader) {
		t.Fatal("expected request without X-Efekta-Client header to be rejected")
	}

	// Browser request with Origin header (CSRF attempt)
	reqOrigin := httptest.NewRequest(http.MethodPost, "/api/exec", nil)
	reqOrigin.Header.Set(ClientHeader, ClientValue)
	reqOrigin.Header.Set("Origin", "https://evil.com")
	if IsAllowedAPIRequest(reqOrigin) {
		t.Fatal("expected request with Origin header to be rejected")
	}

	// Browser request with Sec-Fetch-Site: cross-site
	reqSecFetch := httptest.NewRequest(http.MethodPost, "/api/exec", nil)
	reqSecFetch.Header.Set(ClientHeader, ClientValue)
	reqSecFetch.Header.Set("Sec-Fetch-Site", "cross-site")
	if IsAllowedAPIRequest(reqSecFetch) {
		t.Fatal("expected request with Sec-Fetch-Site: cross-site to be rejected")
	}
}

func TestConcurrentWebSocketCommandsAndMultiBrowserRouting(t *testing.T) {
	srv := NewServer()
	ts := httptest.NewServer(srv.NewMux())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	dialer := websocket.Dialer{
		NetDialContext: (&http.Transport{}).DialContext,
	}
	testHTTPClient := &http.Client{
		Transport: &http.Transport{},
	}

	// Connect Browser 1 (no Efekta tab open)
	header := http.Header{}
	header.Set("Origin", "chrome-extension://browser1")
	conn1, _, err := dialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("failed to connect browser 1: %v", err)
	}
	defer conn1.Close()

	_ = conn1.WriteJSON(protocol.Response{
		Type:         "hello",
		HasEfektaTab: false,
	})

	// Connect Browser 2 (has Efekta tab open!)
	header2 := http.Header{}
	header2.Set("Origin", "moz-extension://browser2")
	conn2, _, err := dialer.Dial(wsURL, header2)
	if err != nil {
		t.Fatalf("failed to connect browser 2: %v", err)
	}
	defer conn2.Close()

	_ = conn2.WriteJSON(protocol.Response{
		Type:         "hello",
		HasEfektaTab: true,
		TabURL:       "https://learn.better.efekta.com/lesson/1",
	})

	// Mock responder on Browser 2
	go func() {
		for {
			var cmd protocol.Command
			if err := conn2.ReadJSON(&cmd); err != nil {
				return
			}
			_ = conn2.WriteJSON(protocol.Response{
				ID:      cmd.ID,
				Success: true,
				Message: "Handled by Browser 2: " + cmd.Action,
			})
		}
	}()

	// Wait briefly for hello registration
	time.Sleep(50 * time.Millisecond)

	// Fire 20 concurrent requests to verify thread-safe WebSocket writes & routing
	const workers = 20
	var wg sync.WaitGroup
	wg.Add(workers)
	errCh := make(chan error, workers)

	for i := 0; i < workers; i++ {
		go func(idx int) {
			defer wg.Done()
			body, _ := json.Marshal(protocol.Command{
				Action: "click",
				Target: "opt-1",
			})
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/exec", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(ClientHeader, ClientValue)

			resp, err := testHTTPClient.Do(req)
			if err != nil {
				errCh <- err
				return
			}
			defer resp.Body.Close()

			var pResp protocol.Response
			if err := json.NewDecoder(resp.Body).Decode(&pResp); err != nil {
				errCh <- err
				return
			}
			if !pResp.Success || !strings.Contains(pResp.Message, "Handled by Browser 2") {
				t.Errorf("unexpected response: %+v", pResp)
			}
		}(i)
	}

	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent request failed: %v", err)
	}
}

func TestSplitTextChunks(t *testing.T) {
	chunks := splitTextChunks("I've thought about it. It's time for a change.", 25)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d: %v", len(chunks), chunks)
	}
}

func TestCommandTimeoutLongMacros(t *testing.T) {
	if got := CommandTimeout(protocol.Command{Action: "autopilot"}); got < 300*time.Second {
		t.Errorf("autopilot timeout too short: %v", got)
	}
	batch := protocol.Command{Action: "batch", Commands: []protocol.BatchSubCommand{{Action: "pick"}, {Action: "dialogue"}}}
	if got := CommandTimeout(batch); got < 300*time.Second {
		t.Errorf("batch with dialogue timeout too short: %v", got)
	}
	if got := CommandTimeout(protocol.Command{Action: "status"}); got != 25*time.Second {
		t.Errorf("status timeout should be 25s, got %v", got)
	}
}

func TestIsAllowedHost(t *testing.T) {
	allowed := []string{
		"127.0.0.1:8765",
		"127.0.0.1",
		"localhost:8765",
		"LOCALHOST",
		"[::1]:8765",
		"::1",
	}
	for _, h := range allowed {
		if !IsAllowedHost(h) {
			t.Errorf("expected Host %q to be allowed", h)
		}
	}

	blocked := []string{
		"",
		"evil.com:8765",
		"127.0.0.1.evil.com:8765",
		"localhost.evil.com",
		"192.168.1.10:8765",
	}
	for _, h := range blocked {
		if IsAllowedHost(h) {
			t.Errorf("expected Host %q to be blocked", h)
		}
	}
}

func TestIsAllowedEfektaTabURL(t *testing.T) {
	if !isAllowedEfektaTabURL("https://learn.better.efekta.com/gap/ui/self-study") {
		t.Error("expected learn.better.efekta.com HTTPS URL to be allowed")
	}
	for _, bad := range []string{
		"",
		"http://learn.better.efekta.com/",
		"https://evil.com/efekta.com",
		"https://efekta.com.evil.com/login",
	} {
		if isAllowedEfektaTabURL(bad) {
			t.Errorf("expected tab URL %q to be rejected", bad)
		}
	}
}

func TestValidateRemoteAudioURLBlocksSSRF(t *testing.T) {
	blockedURLs := []string{
		"http://cdn.efekta.com/audio.mp3",
		"file:///etc/passwd",
		"https://127.0.0.1/secret.mp3",
		"https://169.254.169.254/latest/meta-data/",
		"https://10.0.0.1/internal.mp3",
		"https://172.16.0.5/internal.mp3",
		"https://192.168.1.1/router.mp3",
		"https://100.64.0.1/cgnat.mp3",
		"https://0.0.0.0/zero.mp3",
		"https://[::1]/loopback.mp3",
		"https://[::ffff:127.0.0.1]/mapped.mp3",
		"https://[fe80::1]/linklocal.mp3",
		"https://localhost:8765/api/health",
		"https://internal.service.local/audio.mp3",
		"https://user:pass@8.8.8.8/audio.mp3",
	}
	for _, u := range blockedURLs {
		if _, err := validateRemoteAudioURL(context.Background(), u); err == nil {
			t.Errorf("expected SSRF URL %q to be blocked", u)
		}
	}

	if !isPublicIP(net.ParseIP("8.8.8.8")) {
		t.Error("expected public IP 8.8.8.8 to pass isPublicIP")
	}
	if _, err := validateRemoteAudioURL(context.Background(), "https://8.8.8.8/audio.mp3"); err != nil {
		t.Errorf("expected public HTTPS IP URL to pass validation, got: %v", err)
	}
}
