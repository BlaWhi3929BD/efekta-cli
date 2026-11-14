BINARY_NAME=efekta
BUILD_DIR=bin
DIST_DIR=dist
TARGET_DIR=$(HOME)/.local/bin

.PHONY: all build test install clean release

all: test build

build:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/efekta

test:
	@for f in extension/*.js extension/tests/*.js; do node -c "$$f" || exit 1; done
	node --test extension/tests/extension.test.js
	go vet ./...
	go test -race -v ./...

install: build
	@mkdir -p $(TARGET_DIR)
	@rm -f $(TARGET_DIR)/$(BINARY_NAME)
	cp -f $(BUILD_DIR)/$(BINARY_NAME) $(TARGET_DIR)/$(BINARY_NAME)
	@chmod +x $(TARGET_DIR)/$(BINARY_NAME)
	@echo "✓ Installed $(BINARY_NAME) to $(TARGET_DIR)/$(BINARY_NAME)"
	@echo "Ensure $(TARGET_DIR) is in your PATH."

release:
	@mkdir -p $(DIST_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(DIST_DIR)/$(BINARY_NAME)-linux-amd64 ./cmd/efekta
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o $(DIST_DIR)/$(BINARY_NAME)-linux-arm64 ./cmd/efekta
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(DIST_DIR)/$(BINARY_NAME)-darwin-amd64 ./cmd/efekta
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o $(DIST_DIR)/$(BINARY_NAME)-darwin-arm64 ./cmd/efekta
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(DIST_DIR)/$(BINARY_NAME)-windows-amd64.exe ./cmd/efekta

clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR)
