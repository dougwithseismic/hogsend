BINARY = hogsend
VERSION ?= dev

.PHONY: build test clean release release-snapshot

build:
	go build -ldflags "-X github.com/hogsend/cli/cmd.Version=$(VERSION)" -o $(BINARY) .

test:
	go test ./...

clean:
	rm -f $(BINARY)
	rm -rf dist/

release:
	goreleaser release --clean

release-snapshot:
	goreleaser release --snapshot --clean
