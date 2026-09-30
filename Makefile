export PATH := $(HOME)/.cargo/bin:$(PATH)

.PHONY: all setup build build-core build-cli check clean test

all: build

setup:
	npm --prefix cli install
	cargo build --release --manifest-path core/Cargo.toml
	npm --prefix cli run build

build: build-core build-cli

build-core:
	cargo build --release --manifest-path core/Cargo.toml

build-cli:
	npm --prefix cli run build

check:
	node cli/dist/index.js check

clean:
	cargo clean --manifest-path core/Cargo.toml
	rm -rf cli/dist cli/node_modules

test:
	cargo test --manifest-path core/Cargo.toml
	npm --prefix cli test
