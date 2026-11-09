//go:build windows

package main

import (
	"os"
	"os/exec"
)

func configureBackgroundProcess(cmd *exec.Cmd) {
	// Windows detaches background processes automatically without Unix Setsid
}

func terminateProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}
