export PATH := $(HOME)/.cargo/bin:$(PATH)

.PHONY: all setup build build-core build-cli check clean test audit security-scan sbom verify-reproducibility

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
	rm -rf dist cli/dist cli/node_modules

audit:
	npm --prefix cli audit

security-scan:
	bash scripts/security_gates.sh

sbom:
	bash scripts/generate_sbom.sh

verify-reproducibility:
	@echo "[*] Verifying reproducible build of TypeScript CLI..."
	@rm -rf /tmp/nexus-repro-1 /tmp/nexus-repro-2
	@npm --prefix cli run build
	@mkdir -p /tmp/nexus-repro-1 && cp -r cli/dist/* /tmp/nexus-repro-1/
	@npm --prefix cli run build
	@mkdir -p /tmp/nexus-repro-2 && cp -r cli/dist/* /tmp/nexus-repro-2/
	@diff -r /tmp/nexus-repro-1 /tmp/nexus-repro-2
	@rm -rf /tmp/nexus-repro-1 /tmp/nexus-repro-2
	@echo "[+] Reproducible build verification succeeded (byte-identical artifacts)."

test:
	cargo test --manifest-path core/Cargo.toml
	npm --prefix cli test
	bash scripts/security_gates.sh
