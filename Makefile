.PHONY: verify test hooks
verify:
	./scripts/verify.sh
test:
	cargo test --workspace && pnpm -r test
# Local stand-in for CI: gates pushes to main on ./scripts/verify.sh
hooks:
	git config core.hooksPath .githooks
	@echo "pre-push hook enabled: pushes to main run ./scripts/verify.sh first"
