export PATH := $(HOME)/.cargo/bin:$(PATH)
APPROVED_RUST_BUILD_IMAGE := rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb

.PHONY: all setup build build-core build-cli check clean test test-ci test-fixture-notice audit security-scan sbom verify-reproducibility

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

# `make test` runs every gate and fails at the end, so a CLI failure does not hide the terminal-scope or
# security result. The CLI suite and terminal-scope steps are the two halves of `npm --prefix cli test`.
# CI evaluator fixtures (tmpfs workspace and runtime root) come from `make test-ci`; see docs/DEVELOPMENT.md.
test: test-fixture-notice
	@rc=0; \
	cargo test --manifest-path core/Cargo.toml || { echo "[!] FAILED: cargo test"; rc=1; }; \
	(cd cli && node scripts/run_tests.mjs) || { echo "[!] FAILED: CLI suite"; rc=1; }; \
	bash scripts/terminal-acceptance/test-scope-procs.sh || { echo "[!] FAILED: terminal scope"; rc=1; }; \
	bash scripts/security_gates.sh || { echo "[!] FAILED: security gates"; rc=1; }; \
	if [ $$rc -ne 0 ]; then echo "[!] make test: one or more steps failed (all steps ran)"; fi; \
	exit $$rc

test-fixture-notice:
	@if [ -z "$$NEXUS_EVAL_TEST_WORKSPACE_ROOT" ] || [ -z "$$NEXUS_EVAL_TEST_RUNTIME_ROOT" ]; then \
	  echo "[i] NEXUS_EVAL_TEST_WORKSPACE_ROOT / NEXUS_EVAL_TEST_RUNTIME_ROOT are not set."; \
	  echo "[i] cli/test/eval_version_probe_storage.test.ts will FAIL without them, and cli/test/eval_integrity.test.ts"; \
	  echo "[i] runs its /dev/shm fallback branches instead of the capped-tmpfs ones. This is not a code defect."; \
	  echo "[i] Run 'make test-ci' to provision the same fixtures as CI (needs sudo)."; \
	fi

# Same gates as CI with the CI evaluator fixtures: mounts a capped tmpfs and runtime root, runs `make test`,
# then unmounts and removes only what it created. One-time host setup (not run here):
# scripts/install-evaluator-toolchains.sh, scripts/ensure-ci-bubblewrap.sh, scripts/ensure-ci-user-cgroups.sh.
test-ci:
	bash scripts/with-ci-fixtures.sh -- $(MAKE) test
