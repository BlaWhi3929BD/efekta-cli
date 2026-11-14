package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"efekta-cli/pkg/protocol"
	"github.com/gorilla/websocket"
)

const (
	WsPort       = "8765"
	ClientHeader = "X-Efekta-Client"
	ClientValue  = "efekta-cli"
)

// IsAllowedHost protects against DNS rebinding attacks by allowing only loopback Host headers.
func IsAllowedHost(host string) bool {
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "" {
		return false
	}
	if stripped, _, err := net.SplitHostPort(h); err == nil {
		h = stripped
	}
	h = strings.Trim(h, "[]")
	return h == "127.0.0.1" || h == "localhost" || h == "::1"
}

// isAllowedEfektaTabURL validates that reported tab URLs from browser sessions point to Efekta HTTPS origins.
func isAllowedEfektaTabURL(rawURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	h := strings.ToLower(parsed.Hostname())
	return h == "efekta.com" || strings.HasSuffix(h, ".efekta.com")
}

// IsAllowedWSOrigin prevents malicious web pages (http:// / https://) from hijacking the local WebSocket.
// Only browser extensions (chrome-extension://, moz-extension://, safari-web-extension://) or local tools with no Origin are allowed.
func IsAllowedWSOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	lower := strings.ToLower(origin)
	return strings.HasPrefix(lower, "chrome-extension://") ||
		strings.HasPrefix(lower, "moz-extension://") ||
		strings.HasPrefix(lower, "safari-web-extension://")
}

// IsAllowedAPIRequest protects /api/exec against browser-based CSRF / SSRF attacks.
func IsAllowedAPIRequest(r *http.Request) bool {
	if r.Header.Get("Origin") != "" {
		return false
	}
	if secSite := r.Header.Get("Sec-Fetch-Site"); secSite != "" && secSite != "none" {
		return false
	}
	return r.Header.Get(ClientHeader) == ClientValue
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return IsAllowedHost(r.Host) && IsAllowedWSOrigin(r.Header.Get("Origin"))
	},
}

// ClientSession represents a connected browser extension instance with serialized writes
type ClientSession struct {
	conn         *websocket.Conn
	writeMu      sync.Mutex
	hasEfektaTab bool
	tabURL       string
	userAgent    string
	lastSeen     time.Time
}

func (c *ClientSession) WriteJSONBytes(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Time{})
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

type Server struct {
	mu          sync.Mutex
	clients     map[*ClientSession]bool
	pendingReqs map[string]chan protocol.Response
	reqCounter  uint64
}

func NewServer() *Server {
	return &Server{
		clients:     make(map[*ClientSession]bool),
		pendingReqs: make(map[string]chan protocol.Response),
	}
}

func (s *Server) nextID() string {
	val := atomic.AddUint64(&s.reqCounter, 1)
	return fmt.Sprintf("req-%d-%d", time.Now().UnixNano(), val)
}

// selectActiveClient returns the connected browser session that currently has an Efekta tab open,
// falling back to the most recently active extension session.
func (s *Server) selectActiveClient() *ClientSession {
	s.mu.Lock()
	defer s.mu.Unlock()

	var bestWithTab *ClientSession
	var bestAny *ClientSession

	for c := range s.clients {
		if c.hasEfektaTab {
			if bestWithTab == nil || c.lastSeen.After(bestWithTab.lastSeen) {
				bestWithTab = c
			}
		}
		if bestAny == nil || c.lastSeen.After(bestAny.lastSeen) {
			bestAny = c
		}
	}

	if bestWithTab != nil {
		return bestWithTab
	}
	return bestAny
}

// Handle WebSocket connection from browser extension(s)
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !IsAllowedHost(r.Host) {
		http.Error(w, "Forbidden host", http.StatusForbidden)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[daemon] WS Upgrade rejected/failed: %v", err)
		return
	}
	conn.SetReadLimit(16 << 20)

	session := &ClientSession{
		conn:     conn,
		lastSeen: time.Now(),
	}

	s.mu.Lock()
	s.clients[session] = true
	s.mu.Unlock()

	log.Printf("[daemon] Extension connected from %s (Origin: %s)", conn.RemoteAddr(), r.Header.Get("Origin"))

	defer func() {
		s.mu.Lock()
		delete(s.clients, session)
		s.mu.Unlock()
		conn.Close()
		log.Printf("[daemon] Extension disconnected (%s)", conn.RemoteAddr())
	}()

	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var resp protocol.Response
		if err := json.Unmarshal(msgBytes, &resp); err != nil {
			log.Printf("[daemon] Invalid JSON from extension: %v", err)
			continue
		}

		s.mu.Lock()
		session.lastSeen = time.Now()
		if resp.Type == "hello" || resp.Type == "ping" || resp.Type == "pong" {
			validTab := resp.HasEfektaTab && isAllowedEfektaTabURL(resp.TabURL)
			session.hasEfektaTab = validTab
			if validTab {
				session.tabURL = resp.TabURL
			} else {
				session.tabURL = ""
			}
			if resp.UserAgent != "" {
				session.userAgent = resp.UserAgent
			}
			s.mu.Unlock()
			continue
		}

		if resp.ID != "" {
			if ch, exists := s.pendingReqs[resp.ID]; exists {
				delete(s.pendingReqs, resp.ID)
				ch <- resp
			}
		}
		s.mu.Unlock()
	}
}

// SendCommand dispatches a command to the active browser extension and waits for response
func (s *Server) SendCommand(cmd protocol.Command, timeout time.Duration) (*protocol.Response, error) {
	client := s.selectActiveClient()
	if client == nil {
		return nil, fmt.Errorf("no browser extension connected. Load the extension/ folder in your browser and open https://learn.better.efekta.com")
	}

	s.mu.Lock()
	if cmd.ID == "" {
		cmd.ID = s.nextID()
	}
	respChan := make(chan protocol.Response, 1)
	s.pendingReqs[cmd.ID] = respChan
	s.mu.Unlock()

	payload, err := json.Marshal(cmd)
	if err != nil {
		s.mu.Lock()
		delete(s.pendingReqs, cmd.ID)
		s.mu.Unlock()
		return nil, err
	}

	if err := client.WriteJSONBytes(payload); err != nil {
		s.mu.Lock()
		delete(s.pendingReqs, cmd.ID)
		s.mu.Unlock()
		return nil, fmt.Errorf("write to browser extension failed: %w", err)
	}

	select {
	case resp := <-respChan:
		return &resp, nil
	case <-time.After(timeout):
		s.mu.Lock()
		delete(s.pendingReqs, cmd.ID)
		s.mu.Unlock()
		return nil, fmt.Errorf("timeout (%v) waiting for browser extension response", timeout)
	}
}

// Handle HTTP API calls from CLI
func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	if !IsAllowedHost(r.Host) {
		http.Error(w, "Forbidden host", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !IsAllowedAPIRequest(r) {
		http.Error(w, "Forbidden: invalid origin or missing client header", http.StatusForbidden)
		return
	}

	var cmd protocol.Command
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&cmd); err != nil {
		http.Error(w, fmt.Sprintf("Bad JSON: %v", err), http.StatusBadRequest)
		return
	}

	timeout := CommandTimeout(cmd)

	resp, err := s.SendCommand(cmd, timeout)
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		_ = json.NewEncoder(w).Encode(protocol.Response{
			Success: false,
			Error:   err.Error(),
		})
		return
	}

	_ = json.NewEncoder(w).Encode(resp)
}

// Health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !IsAllowedHost(r.Host) {
		http.Error(w, "Forbidden host", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	clientCount := len(s.clients)
	hasEfektaTab := false
	tabURL := ""
	for c := range s.clients {
		if c.hasEfektaTab {
			hasEfektaTab = true
			tabURL = c.tabURL
			break
		}
	}
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "running",
		"browserConnected": clientCount > 0,
		"connectedClients": clientCount,
		"hasEfektaTab":     hasEfektaTab,
		"tabUrl":           tabURL,
		"time":             time.Now().Unix(),
	})
}

func GetPIDFilePath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(os.TempDir(), "efekta-daemon.pid")
	}
	return filepath.Join(home, ".efekta-daemon.pid")
}

func WritePID() error {
	return os.WriteFile(GetPIDFilePath(), []byte(strconv.Itoa(os.Getpid())), 0600)
}

func RemovePID() {
	_ = os.Remove(GetPIDFilePath())
}

// NewMux returns the HTTP handler mux (used by both Run and unit tests)
func (s *Server) NewMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/exec", s.handleAPI)
	mux.HandleFunc("/api/tts", s.handleTTS)
	mux.HandleFunc("/api/health", s.handleHealth)
	return mux
}

// Run starts the daemon server listening for WS and HTTP
func (s *Server) Run() error {
	_ = WritePID()
	defer RemovePID()

	server := &http.Server{
		Addr:    "127.0.0.1:" + WsPort,
		Handler: s.NewMux(),
	}

	log.Printf("[daemon] Efekta Bridge Daemon v2.0 started on http://127.0.0.1:%s", WsPort)
	return server.ListenAndServe()
}

// CommandTimeout returns how long the daemon waits for the browser extension to answer a command.
// Long-running macros (dialogue, autopilot) legitimately take minutes: every avatar turn plays video and speech.
func CommandTimeout(cmd protocol.Command) time.Duration {
	switch cmd.Action {
	case "dialogue", "autopilot":
		return 300 * time.Second
	case "batch":
		for _, sub := range cmd.Commands {
			if sub.Action == "dialogue" || sub.Action == "autopilot" {
				return 300 * time.Second
			}
		}
		return 60 * time.Second
	case "speak", "skip", "skip_speaking", "solve_choice", "wait", "next", "sort", "pair", "gaps", "essay", "sequence", "lesson":
		return 60 * time.Second
	}
	return 25 * time.Second
}
