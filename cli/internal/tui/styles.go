package tui

import (
	"github.com/charmbracelet/lipgloss"
)

var (
	Primary   = lipgloss.Color("#FF6B35")
	Secondary = lipgloss.Color("#7C3AED")
	Success   = lipgloss.Color("#22C55E")
	Warning   = lipgloss.Color("#EAB308")
	Danger    = lipgloss.Color("#EF4444")
	Muted     = lipgloss.Color("#6B7280")
	White     = lipgloss.Color("#FAFAFA")
	Dark      = lipgloss.Color("#1F2937")

	Title = lipgloss.NewStyle().
		Bold(true).
		Foreground(Primary).
		MarginBottom(1)

	Subtitle = lipgloss.NewStyle().
			Foreground(Muted).
			Italic(true)

	Label = lipgloss.NewStyle().
		Foreground(White).
		Bold(true)

	Value = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#93C5FD"))

	SuccessBadge = lipgloss.NewStyle().
			Foreground(Success).
			Bold(true)

	ErrorBadge = lipgloss.NewStyle().
			Foreground(Danger).
			Bold(true)

	WarningBadge = lipgloss.NewStyle().
			Foreground(Warning).
			Bold(true)

	Card = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Primary).
		Padding(1, 2).
		MarginTop(1)

	DimCard = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Muted).
		Padding(1, 2).
		MarginTop(1)

	Banner = lipgloss.NewStyle().
		Bold(true).
		Foreground(White).
		Background(Primary).
		Padding(0, 2).
		MarginBottom(1)
)
