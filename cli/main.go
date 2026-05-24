package main

import (
	"os"

	"github.com/hogsend/cli/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		os.Exit(1)
	}
}
