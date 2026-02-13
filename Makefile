.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

SHELL	= bash
.ONESHELL:

app_root := $(if $(PROJ_DIR),$(PROJ_DIR),$(CURDIR))

################################################################################
# Developing \
DEVELOP:  ## ##################################################################

.PHONY: install
install:  ## install dependencies
	npm install

.PHONY: dev
dev:  ## run all packages in dev/watch mode
	npm run dev

.PHONY: dev-tsc
dev-tsc:  ## run tsc dev mode (ai + web-ui)
	npm run dev:tsc

################################################################################
# Testing \
TESTING:  ## ##################################################################

.PHONY: test
test:  ## run all workspace tests
	npm run test

.PHONY: test-agent
test-agent:  ## run coding-agent tests
	cd packages/coding-agent && npx vitest run

.PHONY: test-file
test-file:  ## run single test file: make test-file F=test/foo.test.ts
	cd packages/coding-agent && npx vitest run $(F)

################################################################################
# Code Quality \
QUALITY:  ## ##################################################################

.PHONY: precommit
precommit:  ## run all pre-commit hooks
	.husky/pre-commit

.PHONY: check
check:  ## run formatting, linting, and type checking
	npm run check

.PHONY: format
format:  ## run biome formatting
	npx biome check --write .

.PHONY: lint
lint:  ## run biome linting
	npx biome check --error-on-warnings .

.PHONY: typecheck
typecheck:  ## run tsgo type checking
	npx tsgo --noEmit

################################################################################
# Building, Deploying \
BUILDING:  ## ##################################################################

.PHONY: build
build:  ## build all packages (sequential)
	npm run build

.PHONY: binary
binary:  ## build pi agent binary
	cd packages/coding-agent && npm run build:binary

.PHONY: clean
clean:  ## clean all workspace build artifacts
	npm run clean

.PHONY: publish-dry
publish-dry:  ## dry-run publish to npm
	npm run publish:dry

.PHONY: release-patch
release-patch:  ## release patch version
	npm run release:patch

.PHONY: release-minor
release-minor:  ## release minor version
	npm run release:minor

.PHONY: release-major
release-major:  ## release major version
	npm run release:major

################################################################################
# Clean \
CLEAN:  ## ############################################################

.PHONY: clean-all
clean-all: clean  ## clean build artifacts + node_modules
	rm -rf node_modules packages/*/node_modules package-lock.json

.PHONY: reinstall
reinstall: clean-all install  ## clean everything and reinstall

################################################################################
# Misc \
MISC:  ## ############################################################

define PRINT_HELP_PYSCRIPT
import re, sys

for line in sys.stdin:
	match = re.match(r'^([%a-zA-Z0-9_-]+):.*?## (.*)$$', line)
	if match:
		target, help = match.groups()
		if target != "dummy":
			print("\033[36m%-20s\033[0m %s" % (target, help))
endef
export PRINT_HELP_PYSCRIPT

.PHONY: help
help:
	@python -c "$$PRINT_HELP_PYSCRIPT" < $(MAKEFILE_LIST)
