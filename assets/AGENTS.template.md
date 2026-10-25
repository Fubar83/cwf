# AGENTS.md – mall för repon som wf arbetar i

Copilot läser den här filen i varje repo och följer den. wf själv vet ingenting om
repots kod, så allt repospecifikt hör hemma här. Anpassa och checka in i repots rot.

## Om repot
- Vad repot gör, på två–tre meningar.
- Viktigaste katalogerna, t.ex. `src/Api/`, `src/Domain/`, `tests/`, `infra/`.

## Mönster att följa
- Pekare till exempel som ny kod ska efterlikna, t.ex. "Nya endpoints: se `src/Api/Invoices/`".
- Mönster som är utfasade och inte ska kopieras.

## Kod och tester
- Varje ändring har tester. Befintliga tester tas inte bort eller försvagas.
- Kör `dotnet test` (eller motsvarande) innan du anropar ready_for_pr.

## Commits
- En commit per uppgift.
- Format: Conventional Commits, t.ex. `feat(invoices): lägg till CSV-export`.
- Skriv på engelska / svenska (välj).

## PR-text
- Sammanfattning, vad som ändrats, hur det testats.
- Nämn risker och sådant granskaren bör titta extra på.

## ADR
- Skapa en ADR i `docs/adr/` när ett beslut påverkar arkitektur, säkerhet eller drift.
- MADR-format, status alltid `Proposed`. Numret blir nästa lediga.

## AWS CDK
- Ingen AWS-åtkomst. Verifiera med `cdk synth`.
- cdk-nag-undantag kräver motivering i koden och i PR-texten.
- `cdk.context.json` är incheckad; lägg inte till nya lookups.
