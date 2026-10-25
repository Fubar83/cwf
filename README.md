# wf

Tar ett Jira-ärende till en pull request med GitHub Copilot, i devcontainer utan AWS-åtkomst.

wf är ett tunt skal. Copilot fattar innehållsbesluten (plan, kod, tester, commits, PR-text)
utifrån varje repos `AGENTS.md`. wf äger arbetsytan, flödet, kontrollerna, publiceringen och skydden.

## Kom igång

```bash
npm install                 # lås @github/copilot-sdk till en version först, se nedan
cp wf.config.example.yaml ~/.config/wf/config.yaml   # fyll i
ln -s "$PWD/bin/wf" ~/.local/bin/wf
wf run VFS-1350
```

Eller med pnpm, så `wf` finns globalt från vilken mapp som helst:

```bash
pnpm run global             # pnpm install + pnpm add --global
wf run VFS-1350
```

Krav: Node 22+, `git`, `gh` (inloggad), `copilot` (Copilot CLI, inloggad), `twg` (inloggad).

## Kommandon

| Kommando | Vad det gör |
|---|---|
| `wf run <NYCKEL> [repon…]` | Startar eller fortsätter ett ärende. Utan repon används projektets repon från inställningarna. |
| `wf run <NYCKEL> -m "text"` | Lägger till en anteckning till Copilot. Krävs för att fortsätta ett blockerat ärende. |
| `wf run <NYCKEL> --no-publish` | Stannar innan publicering. |
| `wf run <NYCKEL> --aic-limit 500` | AI-kreditak för just den körningen. |
| `wf clean` | Tar bort ärenden vars PR:er är mergade eller stängda. Arkiverar state och beslut. |

Exitkoder: `0` klart · `10` pausad · `20` blockerad · `1` fel.

## Flödet

1. **Förbereda** (wf): förkontroll, lås, en git worktree per repo på branch `vfs-1350-kort-titel`,
   merge av standardbranchen, kontroll om ärendet ändrats sedan förra körningen.
2. **Planera** (Copilot, läsläge): läser ärendet och de Confluence-sidor som är länkade i det,
   ställer blockerande frågor och föreslår en plan på högst en sida.
   Du **godkänner**, ger **feedback** i editorn (Copilot måste svara på varje punkt) eller **pausar**.
3. **Bygga** (Copilot, skrivläge): commit per uppgift, kör kontrollerna tills allt är grönt,
   anropar `ready_for_pr`. wf kontrollerar att allt är committat och kör kontrollerna själv.
4. **Publicera**: du ser commits, ändrade rader och avvikelser från planen och väljer
   **draft**, **redo för granskning** eller **pausa**. wf pushar och skapar PR:erna i beroendeordning.

Pausar du, eller svarar inte på en fråga inom `waitForUserMin`, sparas allt. Nästa `wf run`
börjar med de obesvarade frågorna. Copilot-sessioner återupptas aldrig: filerna i `.wf/` är sanningen.

## Katalogstruktur

```
projects/
├── vfs-api/                  main-checkout
├── vfs-1350/
│   ├── .wf/                  wf:s tillstånd (Copilot får inte skriva här)
│   │   ├── state.json        fas, svar, plan, publicering
│   │   ├── issue.json        ärendet från twg
│   │   ├── plan/v1.md …      planversioner, feedback och approved.md
│   │   ├── decisions.log     beslut och avvikelser
│   │   ├── usage.log         AI-krediter per körning
│   │   └── logs/
│   └── vfs-api/              worktree på ärendets branch
└── .wf-archive/              arkiverade ärenden efter wf clean
```

## Skydd

- **Policy** för varje verktygsanrop (`src/policy.ts`), både i `onPreToolUse` och `onPermissionRequest`.
  Planläget tillåter bara läsande kommandon. Alltid nekat: `git push`, `rebase`, `reset --hard`,
  `checkout`, `stash`, `--no-verify`, skrivande `gh`, `gh api`, `cdk deploy/destroy`, `aws`, `curl`,
  skrivande `twg`, hemligheter, kommandosubstitution, skrivning i `.wf/` eller utanför ärendet.
- **Varningar** till Copilot vid `@ts-ignore`, cdk-nag-undantag, överhoppade tester m.m.
- **Vakt mot hängningar** som står still medan wf väntar på dig.
- **AI-kreditak** per körning. När det nås frågar wf om höjning.
- **Merge, aldrig rebase eller force push.** Konflikter löses i nästa Bygga-varv.
- **Inga dubbletter**: varje publiceringssteg sparas; PR-texten uppdateras bara mellan
  `<!-- wf:start -->` och `<!-- wf:end -->`.
- Inför publicering: ingen ocommittad kod, ingen pågående merge, inga omskrivna pushade commits,
  inga genererade filer (`bin/`, `obj/`, `cdk.out/`, `node_modules/`) eller filer över 5 MB.

## Tester

```bash
npm run typecheck
npm test
```

Testerna kör hela flödet med `FakeAgent` mot riktiga lokala git-repon och ett låtsas-`gh`,
utan nätverk och utan kostnad.

## Att verifiera innan första riktiga körningen (etapp 0)

SDK-adaptern (`src/agent/copilot.ts`) är skriven mot dokumentationen utan att ha kunnat köras.
Ställen att kontrollera är märkta `VERIFIERA`.

1. Lås `@github/copilot-sdk` och Copilot CLI till exakta versioner i `package.json`.
2. Hooks: att `onPreToolUse` får `toolName`/`toolArgs` och att verktygsnamnen för skal och
   filskrivning matchar `classify()` i `src/policy.ts`. Logga några riktiga anrop och justera.
3. `onPermissionRequest`: fältnamnen (`kind`, `fullCommandText`, `fileName`) och att `{ kind: "deny" }` nekar.
4. `assistant.usage` och `session.rpc.usage.getMetrics()`: jämför wf:s AIC med `/usage` på tre sessioner.
5. `customAgents` med annan modell (`gpt-6-luna`), och att modellerna är påslagna i er plan.
6. Hur länge ett verktygsanrop kan stå öppet medan wf väntar på dig.
7. `twg context jira workitem` – att länkade Confluence-sidor och beskrivningen kommer med.

## Inte med i första versionen

Jira-kommentarer, BA-flödet, uppföljning av CI och granskningskommentarer, sub-items,
teamets inställningsfil, `wf status`, byte av session vid full kontext. Kan läggas till när
kärnan körts på några riktiga ärenden.
