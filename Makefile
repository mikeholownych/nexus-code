export PATH := $(HOME)/.cargo/bin:$(PATH)
APPROVED_RUST_BUILD_IMAGE := rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb

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
	@echo "[*] Verifying reproducible package build..."
	@TMP1=$$(mktemp -d) && TMP2=$$(mktemp -d) && \
	VERSION=$$(node -p 'require("./package.json").version') && \
	NEXUS_BUILD_CONTAINER_IMAGE=$(APPROVED_RUST_BUILD_IMAGE) bash scripts/package-linux.sh "v$$VERSION" "$$TMP1" && \
	NEXUS_BUILD_CONTAINER_IMAGE=$(APPROVED_RUST_BUILD_IMAGE) bash scripts/package-linux.sh "v$$VERSION" "$$TMP2" && \
	cmp "$$TMP1/nexus-linux-x86_64-v$$VERSION.tar.gz" "$$TMP2/nexus-linux-x86_64-v$$VERSION.tar.gz" && \
	cmp "$$TMP1/SHA256SUMS" "$$TMP2/SHA256SUMS" && \
	cmp "$$TMP1/THIRD_PARTY_NOTICES.txt" "$$TMP2/THIRD_PARTY_NOTICES.txt" && \
	cmp "$$TMP1/sbom.cdx.json" "$$TMP2/sbom.cdx.json" && \
	cmp "$$TMP1/install.sh" "$$TMP2/install.sh" && \
	rm -rf "$$TMP1" "$$TMP2"
	@echo "[+] Reproducible build verification succeeded (byte-identical artifacts)."

test:
	cargo test --manifest-path core/Cargo.toml
	npm --prefix cli test
	bash scripts/security_gates.sh
