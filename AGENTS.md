# Regras do projeto Tarve

## Performance não regride
- Nenhuma mudança pode piorar a performance: runtime, startup, primeira abertura, CPU, GPU ou memória.
- Tamanho de binário, simplicidade ou conveniência nunca justificam uma regressão. Uma otimização de tamanho só entra com custo de performance zero, comprovado por benchmark (`bun run bench`, `bun run bench:reconcile`, `bun run bench:compare`) antes e depois da mudança.
- Rejeitados por esta regra: `opt-level = "s"`/`"z"` no `[profile.release]` de `native/Cargo.toml`; trocar o gzip das DLLs embutidas no executável txiki.js por brotli/zstd decodificado em JS (`packages/core/txiki/prelude.ts`), que deixaria a primeira abertura mais lenta.

## Paridade de runtimes
- O que funciona no Bun deve funcionar igual em Node.js e txiki.js/QuickJS, salvo recurso realmente não suportado; sem shims ad hoc, skips silenciosos ou branches falsos.
