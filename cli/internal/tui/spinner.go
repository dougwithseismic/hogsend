package tui

import (
	"fmt"
	"os"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"golang.org/x/term"
)

type SpinnerDoneMsg struct{}

type SpinnerModel struct {
	spinner spinner.Model
	message string
	done    bool
	err     error
	action  func() error
}

func NewSpinner(message string, action func() error) SpinnerModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(Primary)
	return SpinnerModel{
		spinner: s,
		message: message,
		action:  action,
	}
}

func (m SpinnerModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.runAction())
}

func (m SpinnerModel) runAction() tea.Cmd {
	return func() tea.Msg {
		if err := m.action(); err != nil {
			return errMsg{err}
		}
		return SpinnerDoneMsg{}
	}
}

type errMsg struct{ err error }

func (m SpinnerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	case SpinnerDoneMsg:
		m.done = true
		return m, tea.Quit
	case errMsg:
		m.err = msg.err
		m.done = true
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m SpinnerModel) View() string {
	if m.err != nil {
		return ErrorBadge.Render("  Error") + " " + m.message + "\n  " + m.err.Error() + "\n"
	}
	if m.done {
		return SuccessBadge.Render("  Done") + " " + m.message + "\n"
	}
	return fmt.Sprintf("  %s %s\n", m.spinner.View(), m.message)
}

func (m SpinnerModel) Err() error {
	return m.err
}

func RunWithSpinner(message string, action func() error) error {
	if !term.IsTerminal(int(os.Stdout.Fd())) {
		fmt.Printf("  %s...\n", message)
		return action()
	}

	m := NewSpinner(message, action)
	p := tea.NewProgram(m)
	result, err := p.Run()
	if err != nil {
		return err
	}
	model, ok := result.(SpinnerModel)
	if !ok {
		return fmt.Errorf("unexpected model type from spinner")
	}
	return model.Err()
}
