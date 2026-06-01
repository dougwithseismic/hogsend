package cmd

import (
	"github.com/spf13/cobra"
)

var Version = "dev"

var rootCmd = &cobra.Command{
	Use:   "hogsend",
	Short: "Hogsend CLI — deploy and manage lifecycle engine instances",
	Long:  "Per-project setup and management tool for Hogsend, the code-first lifecycle engine for PostHog + Resend.",
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.Version = Version
	rootCmd.AddCommand(initCmd)
	rootCmd.AddCommand(setupCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(deployCmd)
	rootCmd.AddCommand(journeysCmd)
	rootCmd.AddCommand(destroyCmd)
	rootCmd.AddCommand(contactsCmd)
	rootCmd.AddCommand(testCmd)
}
