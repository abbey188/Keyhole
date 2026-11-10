.PHONY: verify test
verify:
	./scripts/verify.sh
test:
	cargo test --workspace && pnpm -r test
