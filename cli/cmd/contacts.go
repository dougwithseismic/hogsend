package cmd

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/huh"
	"github.com/hogsend/cli/internal/api"
	"github.com/hogsend/cli/internal/config"
	"github.com/hogsend/cli/internal/tui"
	"github.com/spf13/cobra"
)

var contactsCmd = &cobra.Command{
	Use:   "contacts",
	Short: "Manage contacts",
	Long:  "List, inspect, create, update, and delete contacts and their email preferences.",
}

var contactsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all contacts",
	RunE:  runContactsList,
}

var contactsGetCmd = &cobra.Command{
	Use:   "get [id]",
	Short: "Get contact details",
	Args:  cobra.ExactArgs(1),
	RunE:  runContactsGet,
}

var contactsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a contact",
	RunE:  runContactsCreate,
}

var contactsUpdateCmd = &cobra.Command{
	Use:   "update [id]",
	Short: "Update a contact",
	Args:  cobra.ExactArgs(1),
	RunE:  runContactsUpdate,
}

var contactsDeleteCmd = &cobra.Command{
	Use:   "delete [id]",
	Short: "Delete a contact",
	Args:  cobra.ExactArgs(1),
	RunE:  runContactsDelete,
}

var contactsUnsubCmd = &cobra.Command{
	Use:   "unsub [id]",
	Short: "Toggle global unsubscribe for a contact",
	Args:  cobra.ExactArgs(1),
	RunE:  runContactsUnsub,
}

var contactsPrefsCmd = &cobra.Command{
	Use:   "prefs [id]",
	Short: "View email preferences for a contact",
	Args:  cobra.ExactArgs(1),
	RunE:  runContactsPrefs,
}

var searchFlag string

func init() {
	contactsListCmd.Flags().StringVarP(&searchFlag, "search", "s", "", "Search by email or externalId")

	contactsCmd.AddCommand(contactsListCmd)
	contactsCmd.AddCommand(contactsGetCmd)
	contactsCmd.AddCommand(contactsCreateCmd)
	contactsCmd.AddCommand(contactsUpdateCmd)
	contactsCmd.AddCommand(contactsDeleteCmd)
	contactsCmd.AddCommand(contactsUnsubCmd)
	contactsCmd.AddCommand(contactsPrefsCmd)
}

func newAPIClient() (*api.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}

	if cfg.APIKey == "" {
		return nil, fmt.Errorf("api_key not set in .hogsend.yaml — add your ADMIN_API_KEY")
	}

	url := apiURL(cfg.Railway.Domain)
	return api.NewClient(url, cfg.APIKey), nil
}

func runContactsList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	fmt.Println(tui.Banner.Render("CONTACTS"))
	fmt.Println()

	var result *api.ListContactsResponse
	if err := tui.RunWithSpinner("Fetching contacts...", func() error {
		var e error
		result, e = client.ListContacts(50, 0, searchFlag)
		return e
	}); err != nil {
		return err
	}

	if len(result.Contacts) == 0 {
		fmt.Println("  No contacts found.")
		return nil
	}

	md := fmt.Sprintf("**%d contacts** (showing %d–%d)\n\n", result.Total, result.Offset+1, result.Offset+len(result.Contacts))
	md += "| External ID | Email | Last Seen | Properties |\n"
	md += "|---|---|---|---|\n"

	for _, c := range result.Contacts {
		email := "—"
		if c.Email != nil {
			email = *c.Email
		}
		propCount := len(c.Properties)
		lastSeen := c.LastSeenAt
		if len(lastSeen) > 10 {
			lastSeen = lastSeen[:10]
		}
		md += fmt.Sprintf("| `%s` | %s | %s | %d keys |\n", c.ExternalID, email, lastSeen, propCount)
	}

	out, err := glamour.Render(md, "dark")
	if err != nil {
		fmt.Println(md)
		return nil
	}
	fmt.Print(out)
	return nil
}

func runContactsGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	var result *api.GetContactResponse
	if err := tui.RunWithSpinner("Fetching contact...", func() error {
		var e error
		result, e = client.GetContact(args[0])
		return e
	}); err != nil {
		return err
	}

	c := result.Contact
	email := "—"
	if c.Email != nil {
		email = *c.Email
	}

	propsJSON, _ := json.MarshalIndent(c.Properties, "", "  ")

	md := fmt.Sprintf("## Contact: %s\n\n", c.ExternalID)
	md += fmt.Sprintf("- **ID:** `%s`\n", c.ID)
	md += fmt.Sprintf("- **External ID:** `%s`\n", c.ExternalID)
	md += fmt.Sprintf("- **Email:** %s\n", email)
	md += fmt.Sprintf("- **First Seen:** %s\n", c.FirstSeenAt)
	md += fmt.Sprintf("- **Last Seen:** %s\n", c.LastSeenAt)
	md += fmt.Sprintf("\n### Properties\n\n```json\n%s\n```\n", string(propsJSON))

	if result.Preferences != nil {
		p := result.Preferences
		md += "\n### Email Preferences\n\n"
		md += fmt.Sprintf("- **Unsubscribed:** %v\n", p.UnsubscribedAll)
		md += fmt.Sprintf("- **Suppressed:** %v\n", p.Suppressed)
		md += fmt.Sprintf("- **Bounce Count:** %d\n", p.BounceCount)
		if len(p.Categories) > 0 {
			md += "- **Categories:**\n"
			for cat, subscribed := range p.Categories {
				status := "subscribed"
				if !subscribed {
					status = "unsubscribed"
				}
				md += fmt.Sprintf("  - %s: %s\n", cat, status)
			}
		}
	} else {
		md += "\n*No email preferences set.*\n"
	}

	out, err := glamour.Render(md, "dark")
	if err != nil {
		fmt.Println(md)
		return nil
	}
	fmt.Print(out)
	return nil
}

func runContactsCreate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	var externalID, email, propsStr string

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("External ID").Description("Unique identifier (e.g. PostHog distinct_id)").Value(&externalID).Validate(func(s string) error {
				if strings.TrimSpace(s) == "" {
					return fmt.Errorf("external ID is required")
				}
				return nil
			}),
			huh.NewInput().Title("Email").Description("Optional contact email").Value(&email),
			huh.NewText().Title("Properties (JSON)").Description("Optional JSON object").Value(&propsStr),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		return err
	}

	input := api.CreateContactInput{
		ExternalID: strings.TrimSpace(externalID),
		Email:      strings.TrimSpace(email),
	}

	if propsStr != "" {
		var props map[string]interface{}
		if err := json.Unmarshal([]byte(propsStr), &props); err != nil {
			return fmt.Errorf("invalid JSON in properties: %w", err)
		}
		input.Properties = props
	}

	var result *api.ContactResponse
	if err := tui.RunWithSpinner("Creating contact...", func() error {
		var e error
		result, e = client.CreateContact(input)
		return e
	}); err != nil {
		return err
	}

	fmt.Println(tui.SuccessBadge.Render("Created"))
	fmt.Printf("  ID: %s\n  External ID: %s\n", result.Contact.ID, result.Contact.ExternalID)
	return nil
}

func runContactsUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	var current *api.GetContactResponse
	if err := tui.RunWithSpinner("Fetching contact...", func() error {
		var e error
		current, e = client.GetContact(args[0])
		return e
	}); err != nil {
		return err
	}

	currentEmail := ""
	if current.Contact.Email != nil {
		currentEmail = *current.Contact.Email
	}

	var email, propsStr string

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Email").Description("Leave blank to keep current").Placeholder(currentEmail).Value(&email),
			huh.NewText().Title("Properties to merge (JSON)").Description("Will be merged with existing").Value(&propsStr),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		return err
	}

	input := api.UpdateContactInput{}
	trimEmail := strings.TrimSpace(email)
	if trimEmail != "" {
		input.Email = trimEmail
	}
	if propsStr != "" {
		var props map[string]interface{}
		if err := json.Unmarshal([]byte(propsStr), &props); err != nil {
			return fmt.Errorf("invalid JSON in properties: %w", err)
		}
		input.Properties = props
	}

	var result *api.ContactResponse
	if err := tui.RunWithSpinner("Updating contact...", func() error {
		var e error
		result, e = client.UpdateContact(args[0], input)
		return e
	}); err != nil {
		return err
	}

	fmt.Println(tui.SuccessBadge.Render("Updated"))
	updatedEmail := "—"
	if result.Contact.Email != nil {
		updatedEmail = *result.Contact.Email
	}
	fmt.Printf("  External ID: %s\n  Email: %s\n", result.Contact.ExternalID, updatedEmail)
	return nil
}

func runContactsDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	var current *api.GetContactResponse
	if err := tui.RunWithSpinner("Fetching contact...", func() error {
		var e error
		current, e = client.GetContact(args[0])
		return e
	}); err != nil {
		return err
	}

	email := "—"
	if current.Contact.Email != nil {
		email = *current.Contact.Email
	}

	fmt.Println(tui.WarningBadge.Render("WARNING"))
	fmt.Printf("  This will permanently delete contact %s (%s)\n  and all associated email preferences.\n\n", current.Contact.ExternalID, email)

	var confirm bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().Title("Are you sure?").Value(&confirm),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		return err
	}

	if !confirm {
		fmt.Println("  Cancelled.")
		return nil
	}

	if err := tui.RunWithSpinner("Deleting contact...", func() error {
		return client.DeleteContact(args[0])
	}); err != nil {
		return err
	}

	fmt.Println(tui.SuccessBadge.Render("Deleted"))
	return nil
}

func runContactsUnsub(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	var current *api.GetContactResponse
	if err := tui.RunWithSpinner("Fetching contact...", func() error {
		var e error
		current, e = client.GetContact(args[0])
		return e
	}); err != nil {
		return err
	}

	currentlyUnsubbed := false
	if current.Preferences != nil {
		currentlyUnsubbed = current.Preferences.UnsubscribedAll
	}

	action := "unsubscribe"
	if currentlyUnsubbed {
		action = "resubscribe"
	}

	email := "—"
	if current.Contact.Email != nil {
		email = *current.Contact.Email
	}

	fmt.Printf("  Contact: %s (%s)\n", current.Contact.ExternalID, email)
	fmt.Printf("  Currently: %s\n\n", map[bool]string{true: "unsubscribed", false: "subscribed"}[currentlyUnsubbed])

	var confirm bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().Title(fmt.Sprintf("Do you want to %s this contact?", action)).Value(&confirm),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		return err
	}

	if !confirm {
		fmt.Println("  Cancelled.")
		return nil
	}

	newValue := !currentlyUnsubbed
	if err := tui.RunWithSpinner(fmt.Sprintf("Setting %s...", action), func() error {
		_, e := client.UpdatePreferences(args[0], api.UpdatePreferencesInput{
			UnsubscribedAll: &newValue,
		})
		return e
	}); err != nil {
		return err
	}

	fmt.Println(tui.SuccessBadge.Render(strings.Title(action + "d")))
	return nil
}

func runContactsPrefs(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient()
	if err != nil {
		return err
	}

	var current *api.GetContactResponse
	if err := tui.RunWithSpinner("Fetching contact...", func() error {
		var e error
		current, e = client.GetContact(args[0])
		return e
	}); err != nil {
		return err
	}

	email := "—"
	if current.Contact.Email != nil {
		email = *current.Contact.Email
	}

	md := fmt.Sprintf("## Email Preferences: %s\n\n", current.Contact.ExternalID)
	md += fmt.Sprintf("- **Email:** %s\n", email)

	if current.Preferences == nil {
		md += "\n*No email preferences set — this contact is fully subscribed by default.*\n"
	} else {
		p := current.Preferences
		unsubLabel := "No"
		if p.UnsubscribedAll {
			unsubLabel = "Yes"
		}
		suppressedLabel := "No"
		if p.Suppressed {
			suppressedLabel = "Yes"
		}

		md += fmt.Sprintf("- **Global Unsubscribe:** %s\n", unsubLabel)
		md += fmt.Sprintf("- **Suppressed:** %s\n", suppressedLabel)
		md += fmt.Sprintf("- **Bounce Count:** %d\n", p.BounceCount)

		if len(p.Categories) > 0 {
			md += "\n### Categories\n\n"
			for cat, subscribed := range p.Categories {
				status := "subscribed"
				if !subscribed {
					status = "unsubscribed"
				}
				md += fmt.Sprintf("- **%s:** %s\n", cat, status)
			}
		}
	}

	out, err := glamour.Render(md, "dark")
	if err != nil {
		fmt.Println(md)
		return nil
	}
	fmt.Print(out)
	return nil
}
