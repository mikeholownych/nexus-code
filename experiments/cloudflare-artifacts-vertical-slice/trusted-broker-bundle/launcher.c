#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef BROKER_NODE
#define BROKER_NODE "/opt/nexus-cloudflare-broker/runtime/node"
#endif
#ifndef BROKER_CF_SCRIPT
#define BROKER_CF_SCRIPT "/opt/nexus-cloudflare-broker/cf-runtime/node_modules/cf/bin/cf"
#endif
#ifndef BROKER_SCRIPT
#define BROKER_SCRIPT "/opt/nexus-cloudflare-broker/broker/credential-probe-safe.mjs"
#endif
#ifndef BROKER_ENV_CHECK_SCRIPT
#define BROKER_ENV_CHECK_SCRIPT "/opt/nexus-cloudflare-broker/broker/clean-start-check.mjs"
#endif
#ifndef BROKER_DEMO_TRANSPORT_SCRIPT
#define BROKER_DEMO_TRANSPORT_SCRIPT "/opt/nexus-cloudflare-broker/broker/demo-transport.mjs"
#endif
#ifndef BROKER_HOME
#define BROKER_HOME "/home/mike"
#endif
#ifndef BROKER_XDG_CONFIG_HOME
#define BROKER_XDG_CONFIG_HOME "/home/mike/.config"
#endif
#ifdef BROKER_TEST_BUILD
#ifndef BROKER_TEST_EXPECTED
#define BROKER_TEST_EXPECTED "{}"
#endif
#ifndef BROKER_TEST_RUN_MARKER
#define BROKER_TEST_RUN_MARKER "/tmp/nexus-broker-test-runtime.marker"
#endif
#endif

static int fail(const char *message) {
	fprintf(stderr, "nexus-cf-broker: %s\n", message);
	return 126;
}

static int invoked_by_nexus_sudo(void) {
	const char *sudo_uid = getenv("SUDO_UID");
	return getuid() == 0 && geteuid() == 0 && sudo_uid != NULL && strcmp(sudo_uid, "1000") == 0;
}

int main(int argc, char **argv) {
	if (argc != 2 || (strcmp(argv[1], "version-check") != 0 && strcmp(argv[1], "auth-check") != 0 && strcmp(argv[1], "clean-start-check") != 0 && strcmp(argv[1], "credential-probe") != 0 && strcmp(argv[1], "demo-transport") != 0)) {
		return fail("expected exactly one supported operation");
	}
	if (strcmp(argv[1], "demo-transport") == 0 && !invoked_by_nexus_sudo()) {
		return fail("demo transport requires sudo from the fixed Nexus user");
	}

#ifdef BROKER_TEST_BUILD
	if (strcmp(argv[1], "demo-transport") == 0) {
		puts("TEST_DEMO_TRANSPORT_ADMITTED");
		return 0;
	}
#endif

	if (clearenv() != 0) return fail("cannot clear inherited environment");
	if (setenv("HOME", BROKER_HOME, 1) != 0 ||
	    setenv("XDG_CONFIG_HOME", BROKER_XDG_CONFIG_HOME, 1) != 0 ||
	    setenv("LANG", "C.UTF-8", 1) != 0 ||
	    setenv("PATH", "/usr/bin:/bin", 1) != 0 ||
	    setenv("NO_COLOR", "1", 1) != 0 ||
	    setenv("CF_NO_OSC_PROGRESS", "1", 1) != 0) {
		return fail("cannot construct fixed environment");
	}
#ifdef BROKER_TEST_BUILD
	if (setenv("TEST_EXPECTED", BROKER_TEST_EXPECTED, 1) != 0 ||
	    setenv("RUN_MARKER", BROKER_TEST_RUN_MARKER, 1) != 0) {
		return fail("cannot construct test-only environment");
	}
#endif
	if (chdir("/") != 0) return fail("cannot change to fixed working directory");
	umask(0077);
	struct rlimit core_limit = {0, 0};
	if (setrlimit(RLIMIT_CORE, &core_limit) != 0) return fail("cannot disable core dumps");

	char *cf_argv[] = {BROKER_NODE, BROKER_CF_SCRIPT, "auth", "whoami", NULL};
	char *version_argv[] = {BROKER_NODE, BROKER_CF_SCRIPT, "--version", NULL};
	char *env_check_argv[] = {BROKER_NODE, BROKER_ENV_CHECK_SCRIPT, NULL};
	char *broker_argv[] = {BROKER_NODE, BROKER_SCRIPT, "--real-probe", NULL};
	char *demo_transport_argv[] = {BROKER_NODE, BROKER_DEMO_TRANSPORT_SCRIPT, NULL};
	char **target = strcmp(argv[1], "version-check") == 0 ? version_argv :
		(strcmp(argv[1], "auth-check") == 0 ? cf_argv :
		(strcmp(argv[1], "clean-start-check") == 0 ? env_check_argv :
		(strcmp(argv[1], "credential-probe") == 0 ? broker_argv : demo_transport_argv)));
	execve(BROKER_NODE, target, environ);
	return fail(errno == ENOENT ? "trusted runtime is missing" : "trusted runtime could not be executed");
}
