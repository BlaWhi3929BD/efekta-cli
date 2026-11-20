package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
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
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "chrome-extension", "moz-extension", "safari-web-extension":
		return true
	default:
		return false
	}
}

// IsAllowedAPIRequest protects /api/exec against browser-based CSRF / SSRF attacks.
func IsAllowedAPIRequest(r *http.Request) bool {
	if r.Header.Get("Origin") != "" {
		return false
	}
	if secSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); secSite != "" && secSite != "none" {
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
	_ = c.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

type pendingRequest struct {
	ch      chan protocol.Response
	session *ClientSession
}

type Server struct {
	mu          sync.Mutex
	clients     map[*ClientSession]bool
	pendingReqs map[string]pendingRequest
	reqCounter  uint64
}

func NewServer() *Server {
	return &Server{
		clients:     make(map[*ClientSession]bool),
		pendingReqs: make(map[string]pendingRequest),
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
		for id, req := range s.pendingReqs {
			if req.session == session {
				delete(s.pendingReqs, id)
				select {
				case req.ch <- protocol.Response{
					ID:      id,
					Success: false,
					Error:   "browser extension disconnected while executing command",
				}:
				default:
				}
			}
		}
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
			if req, exists := s.pendingReqs[resp.ID]; exists && req.session == session {
				delete(s.pendingReqs, resp.ID)
				select {
				case req.ch <- resp:
				default:
				}
			}
		}
		s.mu.Unlock()
	}
}

// SendCommand dispatches a command to the active browser extension and waits for response
func (s *Server) SendCommand(cmd protocol.Command, timeout time.Duration) (*protocol.Response, error) {
	return s.SendCommandContext(context.Background(), cmd, timeout)
}

// SendCommandContext dispatches a command to the active browser extension and waits for response or cancellation
func (s *Server) SendCommandContext(ctx context.Context, cmd protocol.Command, timeout time.Duration) (*protocol.Response, error) {
	client := s.selectActiveClient()
	if client == nil {
		return nil, fmt.Errorf("no browser extension connected. Load the extension/ folder in your browser and open https://learn.better.efekta.com")
	}

	s.mu.Lock()
	if cmd.ID == "" {
		cmd.ID = s.nextID()
	}
	respChan := make(chan protocol.Response, 1)
	s.pendingReqs[cmd.ID] = pendingRequest{ch: respChan, session: client}
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
		_ = client.conn.Close()
		return nil, fmt.Errorf("write to browser extension failed: %w", err)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case resp := <-respChan:
		return &resp, nil
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pendingReqs, cmd.ID)
		s.mu.Unlock()
		return nil, fmt.Errorf("request canceled while waiting for browser extension: %w", ctx.Err())
	case <-timer.C:
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

	resp, err := s.SendCommandContext(r.Context(), cmd, timeout)
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
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !IsAllowedWSOrigin(r.Header.Get("Origin")) {
		http.Error(w, "Forbidden origin", http.StatusForbidden)
		return
	}
	if secSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); secSite != "" && secSite != "none" {
		http.Error(w, "Forbidden cross-site request", http.StatusForbidden)
		return
	}

	s.mu.Lock()
	clientCount := len(s.clients)
	var bestWithTab *ClientSession
	for c := range s.clients {
		if c.hasEfektaTab {
			if bestWithTab == nil || c.lastSeen.After(bestWithTab.lastSeen) {
				bestWithTab = c
			}
		}
	}
	hasEfektaTab := bestWithTab != nil
	tabURL := ""
	if bestWithTab != nil {
		tabURL = bestWithTab.tabURL
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

// GetLogFilePath returns a user-private path for daemon startup logs to avoid shared /tmp symlink races.
func GetLogFilePath() string {
	if cacheDir, err := os.UserCacheDir(); err == nil && cacheDir != "" {
		dir := filepath.Join(cacheDir, "efekta")
		if err := os.MkdirAll(dir, 0700); err == nil {
			return filepath.Join(dir, "daemon.log")
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".efekta-daemon.log")
	}
	return filepath.Join(os.TempDir(), "efekta-daemon.log")
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

// closeAllClients closes all connected extension WebSockets during graceful shutdown
func (s *Server) closeAllClients() {
	s.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(s.clients))
	for c := range s.clients {
		conns = append(conns, c.conn)
	}
	s.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

// Run starts the daemon server listening for WS and HTTP
func (s *Server) Run() error {
	ln, err := net.Listen("tcp", "127.0.0.1:"+WsPort)
	if err != nil {
		return err
	}

	if err := WritePID(); err != nil {
		log.Printf("[daemon] Warning: failed to write PID file %s: %v", GetPIDFilePath(), err)
	}
	defer RemovePID()

	server := &http.Server{
		Addr:              "127.0.0.1:" + WsPort,
		Handler:           s.NewMux(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	go func() {
		<-sigCh
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		s.closeAllClients()
		_ = server.Shutdown(ctx)
	}()

	log.Printf("[daemon] Efekta Bridge Daemon v3.0 started on http://127.0.0.1:%s", WsPort)
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// CommandTimeout returns how long the daemon waits for the browser extension to answer a command.
// Long-running macros (dialogue, autopilot) legitimately take minutes: every avatar turn plays video and speech.
func CommandTimeout(cmd protocol.Command) time.Duration {
	switch strings.ToLower(cmd.Action) {
	case "dialogue", "avatar", "autopilot", "auto":
		return 300 * time.Second
	case "speak", "say", "skip_speaking":
		return 120 * time.Second
	case "batch":
		timeout := 60 * time.Second
		for _, sub := range cmd.Commands {
			switch strings.ToLower(sub.Action) {
			case "dialogue", "avatar", "autopilot", "auto":
				return 300 * time.Second
			case "speak", "say", "skip_speaking":
				timeout = 120 * time.Second
			}
		}
		return timeout
	case "skip", "solve_choice", "wait", "sleep", "next", "ff", "sort", "pair", "match", "gaps", "fill", "essay", "write", "sequence", "lesson", "unit":
		return 60 * time.Second
	}
	return 25 * time.Second
}
