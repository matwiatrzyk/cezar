# Cezar Extension System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Delegowanie tylko niezależnych zadań, zgodnie z instrukcjami użytkownika; nie rozdzielać równolegle współdzielonych kontraktów.

**Goal:** Dostarczyć instalowalne rozszerzenia z publicznym SDK, wspólnym cyklem życia i kilkoma rodzajami funkcjonalności, początkowo pisane przez nasz zespół.

**Architecture:** Wersjonowany manifest i SDK, proces wykonawczy na aktywną parę rozszerzenie–projekt, walidowane IPC i kontrolowane API hosta. Frontend renderuje deklaratywne wkłady; adaptery domenowe rozszerzają wspólną platformę.

**Tech Stack:** TypeScript ESM, Node 20+, Zod, Hono, React 19, istniejące komponenty shadcn/ui, Vitest i istniejący runner e2e.

**Spec:** [Projekt systemu](../specs/2026-11-05-extension-system-design.md). Oba dokumenty są propozycją; ten etap nie obejmuje implementacji ani publikacji.

## Global Constraints

- API początkowo `0.1`; host akceptuje wyłącznie jawnie obsługiwaną linię `0.1.x`.
- V1: zaufane rozszerzenia zespołu; osobny proces nie jest sandboxem.
- Instalacja globalna, włączenie i zgody projektowe; bez automatycznego włączania w nowych projektach.
- Brak dodatków = brak procesów, pobrań i zmian zachowania rdzenia.
- Stop 5 s, start 10 s, bazowe RPC 30 s, ramka do 1 MiB, do 100 oczekujących wywołań.
- HTTP: schematy w contract, middleware walidacji, chained Hono routes, `/api/v1`, istniejąca ochrona origin i parytet aliasów.
- Zachować aktualne dane, parowania, zgody, limity, sekrety i działanie wbudowanych integracji. Bez obowiązkowej ręcznej migracji.
- Żadnych pushy, publikacji npm ani pracy na prawdziwych poświadczeniach w ramach wykonania bez odpowiedniej autoryzacji.

## Review Focus

1. Równoczesne instalacje z dwóch cockpitów: jeden spójny rejestr, bez częściowo aktywnej paczki (zadanie 3).
2. Awaria wtyczki podczas operacji: brak zawieszonych promise, wycieków procesów i ponowionego niepewnego efektu (2, 4, 7).
3. Ten sam dodatek w dwóch projektach: brak mieszania danych, sekretów i zgód (4).
4. Update z nowymi uprawnieniami albo nieudaną migracją: stara działająca wersja zachowana, brak milczącego zwiększenia dostępu (3, 6).
5. Usunięty dodatek lub stary zapis komunikatora: historia nadal czytelna, rdzeń startuje bez rozszerzenia (7, 8).

## Kolejność i wielkość przedsięwzięcia

To nowa platforma, nie mała poprawka integracji. Etapy 1–8 tworzą V1. Etapy 9–10 rozszerzają publiczne API na trackery i agentów. Jeden etap może wymagać kilku małych commitów/PR-ów; granicą jest opisany wynik i jego testy. Oszacowanie kalendarza dopiero po 1–2, kiedy sprawdzimy koszt przejścia obecnych interfejsów przez IPC. Nie deklarujemy terminu na podstawie samego loadera.

Zależności: `1 → 2 → 4 → 5`; `1 → 3`; `3 + 4 + 5 → 6`; `4 + 5 → 7`; `6 + 7 → 8`; potem `9` i `10`. Wspólne schematy i integrację zmian prowadzi jeden wykonawca. Najpierw przekrój panel+akcja, potem migracja komunikatora.

## 1. Publiczny manifest, SDK i protokół

**Pliki:** nowe `packages/extension-sdk/{package.json,tsconfig.json,src/index.ts,src/manifest.ts,src/protocol.ts,src/context.ts}`; zmiany `package.json`, `package-lock.json`, `packages/contract/src/{extensions.ts,index.ts}`, `packages/cezar/package.json`, `packages/cezar/scripts/inline-contract.mjs`; test `packages/cezar/src/extensions/manifest.test.ts`.

**Interfejsy:** `defineExtension(definition: ExtensionDefinition): ExtensionDefinition`; `ExtensionDefinition.activate(context: ExtensionContext): Promise<Disposable>`; `Disposable.dispose(): Promise<void>`. Schematy `extensionManifestSchema`, `extensionRpcRequestSchema`, `extensionRpcResponseSchema`; `ExtensionManifest` i typy wire wyłącznie przez `z.infer`. RPC identyfikuje `requestId`, `generation`, `method`, walidowane `params`; odpowiedź ma wynik lub kontrolowany błąd, nigdy surowy wyjątek.

- [ ] Dodać testy `rejectsUnsupportedApi`, `rejectsEscapingEntrypoint`, `rejectsDuplicateContributions`: API `0.2`, `../main.js` i powtórzony command ID są odrzucane; przykład manifestu ze specyfikacji przechodzi.
- [ ] Uruchomić `timeout 300 npx vitest run packages/cezar/src/extensions/manifest.test.ts`; potwierdzić czerwony wynik z brakującego zachowania.
- [ ] Wprowadzić schematy, definicję aktywacji i publiczne eksporty; dodać workspace do build/typecheck oraz zadbać o samodzielne deklaracje i pakowanie bez zależności od prywatnych paczek.
- [ ] Uruchomić ten sam test oraz `timeout 300 npm run typecheck`; zielony wynik. Zacommitować sam kontrakt i jego narzędzia.

## 2. Proces wykonawczy i rejestr wkładów

**Pliki:** nowe `packages/cezar/src/extensions/{host.ts,worker.ts,rpc.ts,registry.ts,host.test.ts,rpc.test.ts}` i fixture procesów w `extensions/test-support/`.

**Interfejsy:** `ExtensionHost.activate(instance: ExtensionInstance): Promise<void>`, `invoke(instanceId: string, commandId: string, input: unknown): Promise<unknown>`, `deactivate(instanceId: string): Promise<void>`; `ExtensionInstance` zawiera zatwierdzony manifest, katalog artefaktu, projectId i generation. Registry rejestruje tylko wkłady zadeklarowane w tym manifeście.

- [ ] Testy: `killsHungActivationAfter10Seconds`, `settlesPendingRequestsOnExit`, `rejectsOversizeFrame`, `rejects101stPendingCall`, `disposesContributionsOnDisable`, `rejectsStaleGeneration`; fake clock oraz prawdziwy proces fixture dla śmierci procesu.
- [ ] `timeout 300 npx vitest run packages/cezar/src/extensions/host.test.ts packages/cezar/src/extensions/rpc.test.ts` ma najpierw zawieść.
- [ ] Zbudować IPC i lifecycle według limitów specyfikacji, minimalne env, anulowanie, czyszczenie i blokadę kolizji ID. Po awarii nie restartować automatycznie. Nie importować kodu wtyczki do procesu HTTP.
- [ ] Powtórzyć testy; potwierdzić brak żywych fixture procesów po zakończeniu. Commit runtime.

## 3. Instalowanie, lokalny development i wersje

**Pliki:** nowe `packages/cezar/src/extensions/{installer.ts,store.ts,updates.ts,installer.test.ts,store.test.ts,updates.test.ts}`; użyć istniejącego `packages/cezar/src/paths.ts`.

**Interfejsy:** `prepareInstall(source: ExtensionSource): Promise<PreparedInstall>`; `commitInstall(preparedId: string): Promise<InstalledExtension>`; `prepareUpdate(extensionId: string, version: string): Promise<PreparedInstall>`. Typy źródła, podglądu i stanu definiować w schematach SDK/contract, nie w api-client. Staging nie wykonuje entrypointu. Katalog development zapisuje realpath; Reload zatwierdza nowy manifest, nie uruchamia build script.

- [ ] Testy: `installNeverRunsLifecycleScripts`, `rejectsArtifactPathEscape`, `serializesConcurrentInstall`, `preservesOldVersionOnFailedUpdate`, `requiresApprovalForAddedPermissions`, `loadsValidRecordsBesideCorruptOne`; fikcyjny rejestr HTTP i izolowany CEZ_HOME.
- [ ] `timeout 300 npx vitest run packages/cezar/src/extensions/installer.test.ts packages/cezar/src/extensions/store.test.ts packages/cezar/src/extensions/updates.test.ts`; potwierdzić red.
- [ ] Zaimplementować rozwiązywanie do dokładnej wersji i integralności, zależności bez skryptów, staging, blokadę między procesami, atomic rename i lokalny rollback. Snapshotować własny stan wtyczki; migracje bez zewnętrznych efektów. Nie zmieniać zależności repo użytkownika.
- [ ] Powtórzyć testy; wykazać, że paczka nie jest wykonywana podczas podglądu/instalacji. Commit instalatora.

## 4. Projektowe API hosta i dostęp do danych

**Pliki:** nowe `packages/cezar/src/extensions/{context.ts,permissions.ts,data.ts,events.ts,context.test.ts}`; rozszerzenie SDK `src/context.ts`; integracja `packages/cezar/src/server/project-context.ts`.

**Interfejsy `ExtensionContext`:** `commands.register(id, handler): Disposable`, `panels.register(id, provider): Disposable`, `tasks.list(): Promise<TaskSummary[]>`, `tasks.propose(input: TaskProposal): Promise<ProposalReceipt>`, `taskEvents.subscribe(handler): Disposable`, `storage.get(key): Promise<JsonValue | undefined>`, `storage.set(key,value): Promise<void>`, `secrets.get/set` dla przestrzeni wtyczki i `logger`. DTO i serializowalne wartości mają schematy SDK. Callbacki pozostają w workerze; RPC przenosi identyfikatory, nigdy funkcje.

- [ ] Testy `rejectsCrossProjectAccess`, `rejectsUndeclaredPermission`, `fencesPendingMutationAfterDisable`, `doesNotExposeSecretsInLogsOrUi`, `resyncsAfterEventOverflow` (kolejka 100 zdarzeń), `proposalDoesNotStartTask`.
- [ ] `timeout 300 npx vitest run packages/cezar/src/extensions/context.test.ts`; red przed implementacją.
- [ ] Dodać broker z tożsamością sesji hosta, projektowym magazynem i istniejącym szyfrowaniem. Propozycja zadania trafia do aktualnego formularza potwierdzenia; późniejsze uruchomienie zachowuje limity istniejącego silnika. Subskrypcje informacyjne bez replay efektów, z resync snapshotu.
- [ ] Powtórzyć testy, zweryfikować cleanup na usunięciu projektu i shutdown serwera. Commit API hosta.

## 5. Pierwsza kompletna wtyczka: panel i akcja

**Pliki:** nowe `packages/extension-sdk/src/ui.ts`, `packages/web/src/components/extensions/{panel.tsx,panel.test.tsx}`, `examples/extensions/project-summary/{package.json,cezar-extension.json,src/index.ts}`; modyfikacje rejestru wkładów z etapu 2.

**Interfejsy:** `ExtensionPanel` jako walidowane drzewo tekstu, statusu, tabeli i przycisków; przycisk wskazuje zadeklarowany command ID. `PanelProvider` zwraca `Promise<ExtensionPanel>`. Akcja `refresh` odczytuje `tasks.list`; panel pokazuje liczbę zadań według stanu, bez dostępu do promptów i sekretów.

- [ ] Testy: panel aktualizuje liczby po refresh, nie wykonuje HTML z tekstu, odrzuca niezadeklarowane przyciski, przechodzi obsługę klawiaturą i pokazuje błąd przy panelu.
- [ ] `timeout 300 npx vitest run packages/web/src/components/extensions/panel.test.tsx`; red, potem implementacja renderera z istniejącymi komponentami.
- [ ] Zbudować przykład w osobnym katalogu z tarballem SDK; zakazać importów z `packages/cezar/src`. Uruchomić przez host fixture; wynik panelu zgodny ze snapshotem zadań.
- [ ] Powtórzyć testy, commit przekroju panel+akcja. To pierwszy dowód, że platforma nie jest ograniczona do komunikatorów.

## 6. Settings → Extensions i HTTP

**Pliki:** nowe `packages/cezar/src/server/extensions.ts`, `packages/web/src/api/extensions.ts`, `packages/web/src/routes/settings/{extensions-section.tsx,extensions-section.test.tsx}`, `packages/cezar/src/server/contract-parity.extensions.test.ts`; zmiany `server/server.ts`, `contract/src/extensions.ts`, `api-client/src/index.ts`, `web/src/routes/settings/registry.tsx` i wspólnego WS.

**Interfejsy:** globalne `/api/v1/extensions` dla listy, przygotowania/commit instalacji, aktualizacji i odinstalowania; projektowe `/api/v1/p/:projectId/extensions/:extensionId` dla enable/disable i wkładów, z aliasem projektu startowego. Konkretne suffixy: `/prepare-install`, `/commit-install`, `/:extensionId/prepare-update`; projektowe `/:extensionId/enable`, `/disable`, `/commands/:commandId/invoke`, `/panels/:panelId`. Każdy body/result definiuje contract przed trasą. Włączenie wiąże zgodę z dokładną wersją i zestawem uprawnień.

- [ ] Testy UI: instalacja nie aktywuje; enable wymaga projektu; dodane uprawnienia wymagają zgody; failed pokazuje Retry; uninstall domyślnie zachowuje dane; Local folder ma Reload. Test HTTP odrzuca obcy origin, niewłaściwy projekt i niepoprawny body.
- [ ] Uruchomić `timeout 300 npx vitest run packages/web/src/routes/settings/extensions-section.test.tsx packages/cezar/src/server/contract-parity.extensions.test.ts`; potwierdzić red.
- [ ] Wprowadzić trasy chained+middleware, dostępny UI i stan pobierany przez istniejący mechanizm subskrypcji. Nie wkładać funkcji połączenia Slack/Discord do managera paczek. Stan operacji pokazywać w dialogu/wierszu zgodnie z komponentami projektu.
- [ ] Powtórzyć testy, parytet tras/typed bodies i typecheck; commit managera rozszerzeń.

## 7. Publiczne API komunikatorów i migracja bez ponownego parowania

**Pliki:** nowe `packages/extension-sdk/src/chat.ts`, `packages/cezar/src/extensions/{chat-bridge.ts,chat-bridge.test.ts}`; zmiany `chat/{provider.ts,registry.ts,runtime.ts}`, `server/{telegram.ts,telegram-service.ts,slack-service.ts,discord-service.ts}`, `webhooks/{service.ts,endpoints.ts}`, `contract/src/{chat.ts,webhooks.ts}`, `web/src/lib/chat-providers/`; nowe fixture `examples/extensions/test-chat/` i zgodność w `chat/test-support/`.

**Interfejsy:** publiczny `ChatExtensionAdapter` z serializowalnymi operacjami identify, inspect, send, clearButtons, acknowledge, isMember oraz event sink. Bridge tłumaczy IPC na dzisiejsze `ChatTransport`/`ChatEventSink`. Funkcje `valid`, Zod, AbortSignal i obiekty journal nie przechodzą przez IPC: host nadaje generation, worker sprawdza ją przed wire effect, journal udostępnia przez wąskie RPC. Autoryzacja, zgody i trwałe przyjęcie zdarzenia pozostają w rdzeniu.

- [ ] Najpierw testy kompatybilności zapisanych receiverów/grantów wszystkich trzech dostawców; fixture czwartego dostawcy z ID `extensionId/localId`; odczyt historii po uninstall; brak fallbacku na webhook po nieudanym bot send.
- [ ] Uruchomić `timeout 300 npx vitest run packages/cezar/src/extensions/chat-bridge.test.ts packages/cezar/src/chat`; zaznaczyć testy nowego zachowania, które zawodzą przed zmianą.
- [ ] Dodać walidowaną przestrzeń zewnętrznych identyfikatorów i dynamiczny lookup bez zamiany wszystkich enumów na dowolny string. Zachować dotychczasowe ID, trasy i kontrakty built-in; nowe rozszerzenia korzystają z jednej generycznej rodziny tras. Audit wyszukiwań po provider/format, renderowania źródła, sekretów, wysyłki, rate limitów i frontendowych descriptorów.
- [ ] Przenieść adaptery najpierw jednego, następnie pozostałych komunikatorów na ten sam kontrakt. Dostarczać je z Cezarem, bez pobierania z npm przy starcie. Każdy krok ma test restartu, zachowania parowania, deduplikacji i odebrania dostępu podczas wire call.
- [ ] Przeprowadzić dotychczasowy conformance suite przez bridge oraz próbny provider spoza repo. Przerwanie IPC po przyjęciu zdarzenia nie tworzy drugiego zadania. Commitować migracje osobno, po zielonych testach każdego dostawcy.

## 8. Pakowanie, dokumentacja i pilot V1

**Pliki:** nowe `docs/extensions.md`, `docs/authoring-extensions.md`, `packages/cezar/src/extensions/package.test.ts`, `packages/web/e2e/extensions.spec.ts`; aktualizacja `docs/adding-chat-provider.md`, `.ai/specs/2026-11-04-chat-providers.md`, `BACKWARD_COMPATIBILITY.md` i indeksu dokumentacji według istniejącego układu.

**Wynik:** instalowalny Cezar plus samodzielny tarball SDK i dwa przykłady. Dokumentować status zaufanego kodu, ograniczenia API 0.1, instalację, lifecycle, testkit i sposób zgłaszania nowych punktów rozszerzeń. Usunąć nieaktualne twierdzenia, że Slack/Discord nie mają botów.

- [ ] Test pakowania: czysty katalog bez monorepo/node_modules; SDK pozwala zbudować przykład, zainstalowany tarball Cezara uruchamia go. Brak runtime zależności od prywatnych pakietów.
- [ ] Scenariusz e2e: install → podgląd → enable w projekcie A → panel/akcja → brak dostępu w B → crash → Retry → update z dodatkowym dostępem → odmowa → stara wersja → disable → uninstall → restart. Osobny scenariusz istniejącego komunikatora zachowuje parowanie. Użyć skilla e2e i symulowanych platform.
- [ ] Uruchomić `timeout 300 npm run typecheck`, `timeout 600 npm run build`, `timeout 600 npm test`, `timeout 300 npm run test:package`, `timeout 300 npm run docs:check` oraz ograniczone czasowo e2e zgodnie z runnerem repo. Nie nazywać pełnej suite zieloną przy znanych wcześniejszych błędach; zapisać baseline i rozdzielić regresje.
- [ ] Przejrzeć diff pod kątem sekretów, lifecycle, aktualizacji i default path. Pilot zespołu na własnych projektach po odrębnej zgodzie na realne połączenia; wynik live oddzielić od symulacji. Commit dokumentacji i dowodów. Publikacja SDK/release to osobna autoryzowana czynność.

## 9. Następna wersja: trackery

**Pliki:** nowe `packages/extension-sdk/src/tracker.ts`, `packages/cezar/src/extensions/{tracker-bridge.ts,tracker-bridge.test.ts}`; zmiany `server/tracker/{types.ts,index.ts,connections.ts}`, `contract/src/tracker.ts`, `web/src/lib/tracker-providers.ts`, `docs/adding-issue-tracker.md`.

**Interfejs:** `TrackerExtensionAdapter` przenosi semantykę istniejącego `TrackerProvider`: discovery, association, list/search/get, kontrolowane komentarze i przejścia. Typy rozszerzeń mają osobną walidowaną gałąź; nie rozluźniać identyfikatorów istniejących trackerów ani przenosić GitHuba do issue-only API.

- [ ] Red: fixture zewnętrznego trackera odrzuca obcy scope/cursor, brak credentials nie blokuje startu, aktualizacja nie usuwa association.
- [ ] Implementacja bridge i opisów UI; migracja jednego built-in trackera z zachowaniem połączeń oraz wspólne conformance tests.
- [ ] `timeout 300 npx vitest run packages/cezar/src/extensions/tracker-bridge.test.ts` i dotychczasowe suite trackerów, typecheck i scenariusz UI. Commit dopiero po zgodności; wtedy dopiero reklamować publiczne API trackerów.

## 10. Następna wersja: backendy agentów

**Pliki:** nowe `packages/extension-sdk/src/runner.ts`, `packages/cezar/src/extensions/{runner-bridge.ts,runner-bridge.test.ts}`; zmiany `core/{agent-runner.ts,runner-factory.ts,backend-detect.ts}`, odpowiednie kontrakty runnerów oraz `AGENT_PROTOCOL.md`.

**Interfejs:** `RunnerExtensionAdapter` odpowiada `AgentRunner`/`AgentSession`, emituje istniejący AgentEvent i UiEvent; jawne start/continue/cancel, strumień zdarzeń i reconnect. To osobny kontrakt strumieniowy, nie długie wywołanie komendy z etapu 2. Budżety, worktree i planowanie pozostają w Cezarze.

- [ ] Red: golden fixture zdarzeń, przerwanie, wznowienie po restarcie, awaria workera bez fałszywego `done`, zachowany `CEZ_DRY_RUN=1` i zwolnienie zajętego slotu.
- [ ] Implementacja bridge, rejestracji metadanych i jednego backendu próbnego spoza repo; bez przymusowej migracji wszystkich istniejących runnerów w jednym PR.
- [ ] `timeout 300 npx vitest run packages/cezar/src/extensions/runner-bridge.test.ts packages/cezar/src/core/runner-factory.test.ts`, golden/parity suite z `AGENT_PROTOCOL.md`, typecheck i build/pack. Commit i dopiero wtedy rozszerzenie deklarowanej powierzchni SDK.

## Kryterium zamknięcia planu V1

Etapy 1–8 mają dowody testów; oba przykłady działają z opublikowalnego SDK bez prywatnych importów; użytkownik instaluje/włącza/wyłącza z UI; stare integracje działają bez ponownego parowania; podstawowy Cezar działa bez żadnych rozszerzeń. Etapy 9–10 są jawnie kolejnymi przyrostami tej samej platformy, a nie ukrytym warunkiem wydania pierwszej wersji.
