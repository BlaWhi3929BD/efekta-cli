//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func configureBackgroundProcess(cmd *exec.Cmd) {
	// CREATE_NEW_PROCESS_GROUP (0x200) + CREATE_NO_WINDOW (0x08000000)
	// Ensures daemon detaches cleanly from parent console without popping up a terminal window
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x08000000,
	}
}

func terminateProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}
