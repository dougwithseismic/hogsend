BINARY = hogsend
VERSION ?= dev

.PHONY: build test clean

build:
	go build -ldflags "-X github.com/hogsend/cli/cmd.Version=$(VERSION)" -o $(BINARY) .

test:
	go test ./...

clean:
	rm -f $(BINARY)
