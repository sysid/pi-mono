.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

SHELL	= bash
.ONESHELL:

# Paths relative to monorepo root
MONO_ROOT := $(shell git rev-parse --show-toplevel)
CODING_AGENT := $(MONO_ROOT)/packages/coding-agent
SANDBOX_DIR := $(CODING_AGENT)/examples/extensions/sandbox

################################################################################
# Testing \
TESTING:  ## ############################################################

.PHONY: test
test:  ## run path-guard unit tests
	cd $(CODING_AGENT) && npx vitest run examples/extensions/sandbox/path-guard.test.ts

.PHONY: test-watch
test-watch:  ## run tests in watch mode
	cd $(CODING_AGENT) && npx vitest watch examples/extensions/sandbox/path-guard.test.ts

.PHONY: test-verbose
test-verbose:  ## run tests with verbose output
	cd $(CODING_AGENT) && npx vitest run --reporter=verbose examples/extensions/sandbox/path-guard.test.ts

################################################################################
# Code Quality \
QUALITY:  ## ############################################################

.PHONY: lint
lint:  ## lint with biome
	cd $(MONO_ROOT) && npx biome check $(SANDBOX_DIR)

.PHONY: lint-fix
lint-fix:  ## autofix linter findings
	cd $(MONO_ROOT) && npx biome check --write $(SANDBOX_DIR)

.PHONY: check
check: lint test  ## run all checks (lint + test)

################################################################################
# Setup \
SETUP:  ## ############################################################

.PHONY: install
install:  ## install extension deps at ~/.pi/agent/extensions/sandbox
	cd ~/.pi/agent/extensions/sandbox && npm install

.PHONY: deps
deps:  ## install monorepo dependencies
	cd $(MONO_ROOT) && npm install

################################################################################
# Misc \
MISC:  ## ############################################################

define PRINT_HELP_PYSCRIPT
import re, sys

for line in sys.stdin:
	match = re.match(r'^([a-zA-Z0-9_-]+):.*?## (.*)$$', line)
	if match:
		target, help = match.groups()
		print("\033[36m%-20s\033[0m %s" % (target, help))
endef
export PRINT_HELP_PYSCRIPT

.PHONY: help
help:
	@python -c "$$PRINT_HELP_PYSCRIPT" < $(MAKEFILE_LIST)
