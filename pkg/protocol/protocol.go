package protocol

// Element represents an interactive element found on the Efekta page
type Element struct {
	ID        string `json:"id"`
	Type      string `json:"type"` // choice, draggable, drop_target, next_btn, skip_btn, activity_nav, mic_btn, stage_nav, input, button
	Text      string `json:"text"`
	Tag       string `json:"tag,omitempty"`
	X         int    `json:"x,omitempty"`
	Y         int    `json:"y,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Selected  bool   `json:"selected,omitempty"`
	Disabled  bool   `json:"disabled,omitempty"`
	ClassName string `json:"className,omitempty"`
}

// VideoStatus represents the state of video/audio avatar in dialogue exercises
type VideoStatus struct {
	HasVideo    bool    `json:"hasVideo"`
	HasAudio    bool    `json:"hasAudio,omitempty"`
	Paused      bool    `json:"paused"`
	Ended       bool    `json:"ended"`
	CurrentTime float64 `json:"currentTime"`
	Duration    float64 `json:"duration"`
	IsPlaying   bool    `json:"isPlaying"`
}

// AgentHint provides a pre-digested summary and ready-to-run batch template for fast AI execution
type AgentHint struct {
	ExerciseType   string   `json:"exerciseType"`
	ActionTemplate string   `json:"actionTemplate"`
	Summary        string   `json:"summary"`
	Slots          []string `json:"slots,omitempty"`
	Items          []string `json:"items,omitempty"`
	Options        []string `json:"options,omitempty"`
	Inputs         []string `json:"inputs,omitempty"`
}

// PageState contains the complete semantic state of the Efekta page
type PageState struct {
	URL           string      `json:"url"`
	Title         string      `json:"title"`
	ExerciseType  string      `json:"exerciseType"` // matching_pairs, categorize_columns, selection_gaps, fill_in_the_blanks, order_sentence, multiple_choice, speaking_avatar, passive_screen, lesson_overview
	Prompt        string      `json:"prompt,omitempty"`
	ContextText   []string    `json:"contextText,omitempty"`
	Feedback      string      `json:"feedback,omitempty"`
	AgentHint     *AgentHint  `json:"agentHint,omitempty"`
	AutoReadNotes []string    `json:"autoReadNotes,omitempty"`
	Video         VideoStatus `json:"video"`
	CanProceed    bool        `json:"canProceed"`
	NextButtonID  string      `json:"nextButtonId,omitempty"`
	ElementsCount int         `json:"elementsCount"`
	Elements      []Element   `json:"elements,omitempty"`
}

// BatchSubCommand represents an individual step in a batch command
type BatchSubCommand struct {
	Action      string `json:"action"` // click, pick, pair, sort, gaps, next, drag, type, press, scroll, sleep/wait, solve_choice, solve_sentence, skip_speaking
	Target      string `json:"target,omitempty"`
	Source      string `json:"source,omitempty"`
	Text        string `json:"text,omitempty"`
	Amount      int    `json:"amount,omitempty"`
	Direction   string `json:"direction,omitempty"`
	DelayMs     int    `json:"delayMs,omitempty"`
	StopOnError bool   `json:"stopOnError,omitempty"`
}

// Command is sent from CLI/Daemon to Extension
type Command struct {
	ID        string            `json:"id"`
	Action    string            `json:"action"` // status, click, pick, pair, sort, gaps, next, drag, type, press, scroll, wait, eval, screenshot, solve_choice, solve_sentence, skip_speaking, batch
	Target    string            `json:"target,omitempty"`
	Source    string            `json:"source,omitempty"`
	Text      string            `json:"text,omitempty"`
	Amount    int               `json:"amount,omitempty"`
	Direction string            `json:"direction,omitempty"`
	DelayMs   int               `json:"delayMs,omitempty"`
	Commands  []BatchSubCommand `json:"commands,omitempty"`
}

// Response is received from Extension
type Response struct {
	ID      string      `json:"id,omitempty"`
	Type    string      `json:"type,omitempty"` // hello, ping, pong (for control messages)
	Success bool        `json:"success"`
	Error   string      `json:"error,omitempty"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
	Results interface{} `json:"results,omitempty"`

	// Extension status metadata on hello/ping
	HasEfektaTab bool   `json:"hasEfektaTab,omitempty"`
	TabURL       string `json:"tabUrl,omitempty"`
	UserAgent    string `json:"userAgent,omitempty"`
}
