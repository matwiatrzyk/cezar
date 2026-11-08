# Zmiany integracji i rozszerzeń względem main

Dokument dla niezależnego specjalisty: opis produktu, implementacji i znanych ograniczeń gałęzi `feature/chat-integrations-clean`. Stan z 8 listopada 2026. Opis nie jest certyfikatem poprawności: przegląd wykazał błędy mimo przechodzących testów. Ścieżki poniżej są względne wobec katalogu głównego repozytorium; należy czytać je w wskazanym commicie.

## 1. Dokładny zakres porównania

| Element | Wartość |
| --- | --- |
| Oceniany commit | `7d1cbcf64eba3e676fdc1da12de026aaefb639c4` |
| Lokalny ref `upstream/main` przy sporządzaniu opisu | `a0e39453bce53fd800ece924e7898d269be69bbe` |
| Wspólny przodek, baza zmian funkcji | `4073c635cf71d1574a946dccfb7249a39bd2597a` |
| Lokalny `origin/main` | `0e9dfd76456e0abf44fd0037d4d1b52b43b9e8f7` — nie jest bazą tego opisu |
| Diff wspólna baza → oceniany commit | 500 plików, 36 865 dodanych i 603 usunięte linie |
| Rozbieżność względem `upstream/main` | 36 commitów tylko po stronie main, 157 tylko po stronie gałęzi; liczby obejmują historię merge |

Nie wykonano nowego fetch przy sporządzaniu dokumentu. Podane referencje są lokalnymi, zamrożonymi punktami porównania. `git diff upstream/main...HEAD` opisuje wkład gałęzi od wspólnej bazy; dwukropkowe porównanie końcowych drzew obejmowałoby też brak późniejszych zmian maina. Ten dokument dodano po ocenianym commicie, więc nie wchodzi do powyższych statystyk.

```sh
git diff --stat 4073c635cf71d1574a946dccfb7249a39bd2597a 7d1cbcf64eba3e676fdc1da12de026aaefb639c4
git diff --name-status 4073c635cf71d1574a946dccfb7249a39bd2597a 7d1cbcf64eba3e676fdc1da12de026aaefb639c4
git log --oneline 4073c635cf71d1574a946dccfb7249a39bd2597a..7d1cbcf64eba3e676fdc1da12de026aaefb639c4
```

## 2. Koncepcja i zmiana produktu

Baza miała lokalny cockpit, zadania agentów, workflow, trackery i wychodzące webhooki. Gałąź dodaje dwukierunkowe sterowanie zadaniami z komunikatorów, wspólną warstwę providerów i instalowalne rozszerzenia z publicznym SDK. Katalogi `packages/cezar/src/chat`, `packages/cezar/src/extensions` oraz pakiet `packages/extension-sdk` są nowe względem wskazanej bazy.

| Obszar | Zmiana | Znaczenie dla użytkownika |
| --- | --- | --- |
| Komunikatory | Telegram, Slack i Discord korzystają ze wspólnego modelu konfiguracji, powiązań, uprawnień i kontroli zadań | Użytkownik może odbierać wyniki i sterować istniejącym systemem zadań przez czat |
| Uruchamianie z czatu | Parowanie, zgody per osoba, podgląd i potwierdzanie działań | Samo posiadanie tokenu bota lub dostęp do kanału nie daje prawa wykonywania zadań |
| Integracje w UI | Galeria Settings → Integrations, kreatory, testy połączenia, zarządzanie ludźmi i czatami | Konfiguracja komunikatorów i istniejących integracji ma wspólne miejsce |
| Rozszerzenia | Instalacja z npm lub lokalnego folderu, podgląd uprawnień, włączanie per projekt, aktualizacja i odinstalowanie | Własne funkcje można dostarczać poza kodem głównym |
| SDK | Komendy, panele, formularze, providerzy czatu, odczyt zadań i propozycje nowych zadań | Autor rozszerzenia otrzymuje ograniczony, jawny interfejs hosta |
| V1.1 | Panele w sidebarze i zadaniu, komendy w palecie i zadaniu | Funkcje rozszerzeń wychodzą poza stronę Settings |

Decyzje właściciela: rozwój długotrwałego forka, pozostawienie flag środowiskowych, zachowanie eksperymentalnego SDK API 0.1 i realizacja V1.1 teraz. Nie należy traktować tych decyzji jako niezatwierdzonych propozycji refaktoru. Rozszerzenia nie zastępują jeszcze wszystkich mechanizmów Cezara: nie dostarczono publicznych adapterów trackerów i backendów agentów przez ten SDK.

## 3. Perspektywa biznesowa

Odbiorcą jest operator lokalnego środowiska oraz zaufani współpracownicy i autorzy rozszerzeń. Wartość polega na krótszej drodze od wiadomości lub zdarzenia do istniejącego zadania, a następnie na dostarczeniu wyniku do rozmowy. Rozszerzenia mają ograniczać konieczność zmieniania rdzenia przy dodawaniu obsługiwanych rodzajów integracji.

Koszt wejścia nadal obejmuje konfigurację aplikacji/bota na platformie, poświadczenia, odpowiednie uprawnienia platformowe, flagi Cezara i zatwierdzenie osób. Flagi są świadomie zachowane; kreator nie eliminuje obowiązków administratora Slacka czy Discorda. Zgoda na wykonywanie zadań z czatu oznacza potencjalny koszt modelu i możliwość uruchomienia agenta z dostępem do powłoki.

Nie przedstawiono pomiarów adopcji, czasu konfiguracji, niezawodności produkcyjnej ani finansowego zwrotu. Korzyści biznesowe są hipotezą wynikającą z przepływów produktu, a nie udowodnionym KPI. Do oceny pilotażu nadają się: odsetek zakończonych konfiguracji, czas do pierwszego poprawnego zadania, liczba ponownych prób i utraconych wiadomości, udział zadań rozpoczynanych z czatu oraz koszt utrzymania integracji na forkowanych wydaniach.

Blokady dla pilotażu w ocenianym stanie: Telegram nie odbiera przez domyślną ścieżkę workerową, a przykład Mattermosta nie potrafi dostarczyć potwierdzenia utworzenia zadania. Nie można uznać kompletności katalogu providerów za dowód kompletności przepływów użytkownika.

## 4. Architektura i odpowiedzialności

```text
Platforma czatu
  ↕ API / Socket Mode / Gateway / polling
Transport providera: bundled worker albo adapter w procesie hosta
  ↕ walidowane IPC dla workera
ChatHost → ChatInbound / ChatBotRuntime
  → lease bota, parowanie, granty, członkostwo, dziennik i deduplikacja
  → potwierdzone działania → istniejący mechanizm zadań i workflow
  → korelacja wyniku → wiadomość w rozmowie

Manifest rozszerzenia → instalator → globalny katalog artefaktów
  → zgoda konkretnego projektu → ExtensionManager → ExtensionHost → proces Node
  ↕ walidowane IPC i kontekst ustalony przez hosta
SDK: komendy / panele / formularze / czat / odczyt i propozycje zadań
  ↕ HTTP i sygnały zmian
Cockpit: Settings / sidebar / paleta / widok Extensions zadania
```

| Warstwa | Główne pliki | Odpowiedzialność i pytanie kontrolne |
| --- | --- | --- |
| Kompozycja chatu | `packages/cezar/src/chat/host.ts`, `chat/service.ts`, `chat/runtime.ts` | Czy każdy provider przechodzi przez wspólne reguły? Czy wybór transportu poprzedza rozpoczęcie odbioru? |
| Provider | `chat/provider.ts`, `chat/providers/{telegram,slack,discord}/` | Identyfikacja, wysyłka, odbiór, prezentacja i semantyka platformy; czy wspólny interfejs nie ukrywa wymagań specyficznych dla providera? |
| Trwałość i dostęp | `chat/ownership.ts`, `state.ts`, `inbox.ts`, `authorization.ts`, `actions.ts`, `conversation.ts` | Jeden właściciel bota, odzyskiwanie, granty, potwierdzenia i deduplikacja |
| Wyjściowe powiadomienia | `webhooks/service.ts`, `transport.ts`, `coordinator.ts`, `admission.ts` | Powiązanie z transportem bota, istniejąca kolejka dostarczeń i korelacja wiadomości z zadaniem |
| Workery bundled | `extensions/bundled-{catalog,host,runtime,worker}.ts`, `worker-process.ts` | Weryfikacja artefaktu, uruchomienie, generacje, restart, zatrzymanie i fallback |
| Wtyczki użytkownika | `extensions/{installer,store,manager,host,extension-worker,context,chat-bridge}.ts` | Cykl życia, zgody, izolacja danych projektu, granica SDK/IPC |
| Kontrakt i API | `packages/contract/src/{chat,extensions,telegram,slack-chat,discord-chat}.ts`, `server/{chat-routes,extensions,server}.ts` | Zod, middleware walidujące, łańcuchy tras i projekcja odpowiedzi |
| Frontend | `packages/web/src/api/extensions.ts`, `components/extensions/`, `routes/settings/`, `routes/task-workspace/extensions-column.tsx` | Renderowanie wkładów, obsługa rezultatów i błędów, synchronizacja stanu |

Slack używa Socket Mode i API Slacka; rotacja tokenów jest koordynowana przez hosta, ze współdzielonymi blokadami i stanem sekretów. Discord używa Gateway i REST oraz obsługuje natywne komendy. Telegram używa długiego odpytywania Bot API z trwałym offsetem. To różne semantyki odbioru, nawet gdy interfejs transportu jest wspólny.

W lokalnym buildzie z poprawnym katalogiem skonfigurowane boty wybierają bundled workers. Przy `CEZ_EXTENSIONS=0`, trybie hostowanym lub braku poprawnych artefaktów pozostaje ścieżka zgodności w procesie hosta; pozostałe ograniczenia funkcji chatu nadal obowiązują. Worker i fallback nie powinny konsumować tego samego bota równocześnie. Istnieje ograniczony budżet restartów i kontrolowane zatrzymanie. Stan `blocked` bez zakończenia procesu, jak w błędzie Telegrama, nie uruchamia fallbacku opartego na awarii.

## 5. Przepływy do weryfikacji

### Konfiguracja i użycie czatu

1. Operator włącza wymagane flagi i konfiguruje poświadczenia przez Integrations.
2. Kreator identyfikuje bota i sprawdza kanał/czat; konfiguracja powiadomień i zgoda na sterowanie zadaniami są rozdzielone.
3. Parowanie wiąże osobę i rozmowę; operator nadaje konkretne prawa. W grupach sprawdzane jest członkostwo i poprawne adresowanie wiadomości.
4. Wiadomość jest normalizowana, weryfikowana i zapisywana zgodnie z mechanizmem odbioru. Działania wymagające potwierdzenia mają podgląd i jednorazowe potwierdzenie.
5. Powstaje zwykłe zadanie lub operacja na istniejącym zadaniu. Źródło czatu jest powiązane z zadaniem; wynik i odpowiedzi mogą wrócić do odpowiedniej rozmowy.
6. Cofnięcie dostępu, zmiana konfiguracji i zatrzymanie powinny uniemożliwiać nowe efekty. Znana luka w zewnętrznym SDK dotyczy już oczekującej wysyłki.

Sprawdzić restart po przyjęciu wiadomości, lecz przed odpowiedzią, ponowne dostarczenie tego samego zdarzenia, utratę członkostwa w grupie, cofnięcie grantu podczas operacji oraz próbę działania w innym projekcie. Nie zakładać ogólnej gwarancji exactly-once: deduplikacja hosta nie usuwa wszystkich okien utraty pomiędzy platformą a hostem.

### Rozszerzenia i V1.1

Instalacja tworzy globalny, wersjonowany artefakt; uruchomienie wymaga zgody per projekt. Aktualizacja uwzględnia zmianę uprawnień, a manager posiada mechanizm snapshot/restore przy nieudanej aktualizacji. To nie cofa wykonanych wcześniej efektów w systemie zewnętrznym. Odinstalowanie może zachować dane albo usunąć dane należące do rozszerzenia; wspólna historia zadań nie jest jego własnością.

SDK udostępnia `tasks.list`, `tasks.get`, `tasks.propose`, storage, namespacowane secrets, logger, taskEvents oraz rejestrację wkładów. `project.read` obejmuje odczyt zadań, `task.create` pozwala proponować zadania. `tasks.propose` nie jest automatycznym uruchomieniem zadania. Nie opisywać storage/secrets jako osobnych deklarowanych uprawnień: w tym API ich granicą jest kontekst rozszerzenia i projektu.

Opcjonalne `location` wskazuje Settings/sidebar/task dla paneli i Settings/palette/task dla komend. Brak pola zachowuje Settings. Limity manifestu to 3 panele sidebar, 5 paneli task i 20 komend palety. Kontekst `runId` jest sprawdzany przez hosta względem projektu. Przykład `project-summary` korzysta ze wszystkich miejsc. Mattermost demonstruje zewnętrznego providera, ale ma znane luki funkcjonalne opisane niżej.

## 6. Bezpieczeństwo i model zaufania

| Granica | Wprowadzone mechanizmy | Co trzeba niezależnie sprawdzić |
| --- | --- | --- |
| Internet → host | Połączenia providerów, walidacja identyfikatorów i zdarzeń, ograniczenia miejsc docelowych | Adresowanie, rozmiary, błędne dane, przekierowania i zachowanie po utracie poświadczeń |
| Osoba z czatu → zadanie | Parowanie, zgody, członkostwo, potwierdzenia, generacje uprawnień | Replay przycisku, revoke podczas pracy, obcy projekt, niewłaściwy użytkownik |
| Wtyczka → host API | Ustalony projekt, walidowane IPC, zgody, ograniczone operacje i rozmiary | Czy dane wejściowe mogą podmienić projekt/runId lub ominąć zgodę? |
| Pakiet → system plików | Instalacja bez skryptów, integralność, kontrola ścieżek/symlinków i rozmiaru rozpakowania | Uszkodzone archiwa, przekroczenia limitów i podmiana artefaktu |
| Sekret → diagnostyka/UI | Magazyn sekretów, audience, fingerprint i redakcja znanych wartości | Wyjątki oraz surowe stdout/stderr; obecnie potwierdzony wyciek w logu awarii |

Worker działa jako ten sam użytkownik systemowy. Osobny proces zapewnia obsługę awarii, nie sandbox bezpieczeństwa. Uprawnienia SDK kontrolują host API, nie dowolny bezpośredni dostęp wtyczki Node do systemu plików i sieci. Wtyczki są zaufanym kodem; repozytorium nie wdraża modelu nieufnego marketplace z izolacją OS.

TelegramSecrets jest kodekiem opartym o wspólne ChatSecrets i SecretStore (`webhooks/telegram-secrets.ts`). Token jest używany przy budowie adresu Telegram Bot API, co nie dowodzi zapisu plaintextowego tokenu w publicznej konfiguracji. Wcześniejsze stwierdzenie, że Telegram w ogóle nie korzysta z ChatSecrets, było nieprawidłowe. Osobno trzeba zweryfikować każdą projekcję, log i stary format danych.

Do rekordów zadań dodano źródło czatu; `runs/public-run.ts` usuwa z publicznej projekcji surowe identyfikatory użytkownika, bota, czatu i wiadomości. Nowe trasy korzystają z istniejącej ochrony origin/host; CSRF i loopback nie są w całości nową funkcją tej gałęzi.

## 7. UX UI i dostępność

Zmiana obejmuje galerię integracji, wspólne kreatory providerów, zarządzanie dostępem i testami połączeń oraz stronę Extensions. Istniejące ustawienia trackerów i TesterArmy dostały nowe umiejscowienie lub etykiety; nie oznacza to napisania od nowa ich backendów. Starsze wejścia do ustawień są uwzględnione w routingu.

Paleta ma grupę Extensions, sidebar zwijane sekcje, a workspace zadania opcjonalny widok Extensions. Błędy paneli mają pozostać lokalne dla karty. Rezultaty komend i propozycje zadań mają własne miejsce prezentacji; wyłączone funkcje pokazują powód. Stan zwinięcia sidebaru jest zapisywany w UI-state. Subskrypcja zmian rozszerzeń uwzględnia dostępność funkcji i tryb lokalny.

W kodzie i testach występują etykiety pól, nagłówki dialogów, statusy i alerty, retry oraz komunikaty aria-live. Nie wykonano nowego audytu wizualnego w przeglądarce, na urządzeniach mobilnych ani ze screen readerem w ostatnim przeglądzie. Ocena poprawności kontrastu, przepełnień, nawigacji klawiaturą i faktycznego zachowania fokusu wymaga osobnego przejścia.

Scenariusze krytyczne dla UX: błędny token i ponowienie, konfiguracja przy wyłączonej fladze, cofanie dostępu przy wyłączonym inbound, kilka projektów, restart wtyczki podczas oglądania panelu, dwie komendy kończące się w odwrotnej kolejności, odświeżenie formularza z niezapisanymi zmianami i aktualizacja listy rozszerzeń w czasie parowania.

## 8. Kompatybilność i spójność z projektem

HTTP pozostaje pod `/api/v1`, z trasami projektowymi `/api/v1/p/:projectId/...`. Schematy HTTP należą do `packages/contract`, DTO autorów do publicznego SDK, a ramki IPC do `extensions/protocol.ts`. Trasy powinny być łańcuchowane i walidowane middleware; testy contract-parity i typed-bodies sprawdzają ten warunek.

Nazwy ogólnej implementacji chatu odchodzą od prefiksu telegram, lecz stare adresy, formaty i aliasy kontraktu pozostają dla kompatybilności. Publiczne ID bundled providerów to telegram/slack/discord, formaty to odpowiednio `.v1`; zewnętrzny provider ma kwalifikowane `extensionId/localId`.

SDK pozostaje API 0.1, z polityką zmian addytywnych opisaną w BACKWARD_COMPATIBILITY §6b. Stary manifest działa na nowym hoście, ale nowy manifest z `location` może zostać odrzucony przez stary ścisły parser. Nie jest to symetryczna kompatybilność. Nowy literal widoku zadania `extensions` jest obsługiwany przez aktualny loader; dodane filtrowanie nieznanych widoków nie zmienia zachowania już wydanych starszych binariów.

Health otrzymuje obowiązkowe `capabilities.extensions`. Starszy działający cockpit może nie przejść walidacji nowszego CLI, które uzna go za niekompatybilny. Wymaga to sprawdzenia przy scenariuszu kilku wersji na jednej maszynie.

Nowy stan obejmuje katalogi botów/leases, dzienniki i granty chatu, globalne artefakty rozszerzeń, zgody i dane projektu, sekrety oraz blokady rotacji Slacka. Dokładny wykaz i zasady downgrade są w BACKWARD_COMPATIBILITY §3, §6b i §9 oraz implementacjach store/data/credentials. Ścieżki domu przechodzą przez `cezarHomeDir()`/`CEZ_HOME`; testy nie powinny używać rzeczywistego domu użytkownika.

`CEZ_WEBHOOKS=1` włącza powiadomienia/setup, `CEZ_CHAT_INBOUND=1` dodatkowo sterowanie, a `CEZ_EXTENSIONS=0` wyłącza workery i wtyczki. Rozszerzenia są domyślnie dostępne lokalnie; AGENTS odnotowuje wyjątek jako pending owner ratification w kontekście upstream. Dla ocenianego forka to przyjęty kierunek. `.env.example` w ocenianym commicie nadal wymienia tylko Slack/Discord przy bundled workerach, podczas gdy docs/reference i kod obejmują Telegram — dodatkowa niespójność dokumentacyjna do poprawienia.

## 9. Zmiany programistyczne poza główną funkcją

- Dodano piąty workspace, `@open-mercato/cezar-extension-sdk`, i włączono go do wersjonowania, publikowania oraz testów paczek. Contract i api-client pozostają prywatne i bez zależności od Node na swoim publicznym poziomie.
- Build tworzy trzy artefakty bundled wraz z katalogiem i SHA-512. Sprawdzanie paczki kontroluje ich obecność i integralność. Bundlowanie/inlining zapobiega wymaganiu prywatnego workspace jako nieosiągalnej zależności npm.
- CI uruchamia testy SDK i test konsumenta spakowanego SDK/usługi poza workspace. Zmiany: `.github/workflows/ci.yml`, `scripts/release*`, `packages/cezar/src/release/`, skrypty build/check-pack.
- `workflows/run.ts` i serwerowe run-messages/run-controls współdzielą działania potrzebne także chatowi; źródło chatu jest zapisywane w rekordzie i odpowiednio projektowane na publiczne API.
- Retencja runów zachowuje potrzebnych przodków dispatch; sprzątanie worktree uwzględnia brudne drzewa i unikalne commity. To niezależne poprawki bezpieczeństwa danych, a nie wymaganie samego protokołu czatu.
- Zmieniono SecretStore tak, by zapis mógł ponownie sprawdzić aktywność przed trwałą podmianą pliku; rozróżniono ponownie użyty identyfikator projektu z innym katalogiem głównym.
- Część testów opartych o rzeczywiste oczekiwanie przepisano na fake timers. Sama poprawa czasu nie dowodzi pokrycia semantyki; test rzeczywistego Telegram workera pozostaje brakującym przypadkiem.

## 10. Porównanie z podobnymi rozwiązaniami

Oficjalne źródła sprawdzone podczas przeglądu 8 listopada 2026:

| Punkt odniesienia | Fakt ze źródła | Wniosek dla Cezara |
| --- | --- | --- |
| [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) | Rozszerzenia działają w hostach o różnych lokalizacjach i runtime, w tym lokalnym Node | Worker jest rozpoznawalnym wzorcem; nie wynika z tego równoważność izolacji lub całego API |
| [VS Code Contribution Points](https://code.visualstudio.com/api/references/contribution-points) | Manifest deklaruje wkłady, m.in. komendy i widoki | Deklarowane locations i renderer Cezara są spójnym, węższym zastosowaniem tego podejścia |
| [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest) | `engines.vscode` określa wspierane wersje hosta | Przydatna byłaby tabela minimalnych wersji Cezara dla kolejnych dodatków API 0.1 |
| [Mattermost Plugins](https://docs.mattermost.com/developers/integrate/plugins) | Dostępne są wkłady UI i usługi serwerowe zarządzane przez RPC | Wtyczki mogą ograniczać potrzebę modyfikowania rdzenia, jeśli przykład przechodzi pełny wspierany przepływ |

Wnioski w trzeciej kolumnie są oceną architektury, nie deklaracją kompatybilności z tymi produktami. Nie wykonano benchmarku wydajności ani pełnego porównania rynku. Nie ma podstaw do wymagania marketplace, izolacji wielodzierżawnej lub pełnego API VS Code tylko dlatego, że użyto podobnego wzorca.

## 11. Rejestr potwierdzonych problemów

Numery linii odnoszą się do ocenianego commita. P1 oznacza problem blokujący podstawowy przepływ; P2 istotny błąd do naprawy; P3 niespójność o mniejszym bezpośrednim wpływie.

| ID | Priorytet | Lokalizacja | Wyzwalacz i obserwacja | Warunek zamknięcia |
| --- | --- | --- | --- | --- |
| R1 | P1 | `extensions/bundled-worker.ts:20,43,106`, `chat/providers/telegram/poller.ts:49` pod `packages/cezar/src/` | Rzeczywisty transport Telegrama z journal proxy kończy jako blocked, bez getUpdates; process jest no-op | Rzeczywisty bundled entrypoint odbiera, przekazuje aktualizację do hosta i zachowuje trwały offset po restarcie |
| R2 | P2 | `packages/cezar/src/extensions/host.ts:80` | Worker wypisuje sekret i ulega awarii; log hosta zawiera sekret | Test awarii i redakcji stderr/stdout, bez sekretu w wynikowej diagnostyce |
| R3 | P2 | `packages/cezar/src/extensions/chat-bridge.ts:10` | Cofnięcie zgody i AbortSignal podczas oczekiwania; efekt nadal następuje, odpowiedź dopiero potem blocked | Kontekst anulowania dociera do rzeczywistego adaptera, efekt przed-wire jest zatrzymany |
| R4 | P2 | `packages/cezar/src/extensions/manager.ts:273,291,571` | Dwa procesy; po aktualizacji drugi pokazuje 1.0.1, ale nowa komenda nie jest zadeklarowana w starym workerze | Test aktualizacji i uzgodnienia aktywnego artefaktu między procesami |
| R5 | P2 | `examples/extensions/mattermost/src/index.ts:32` | Send usuwa Confirm/Cancel, a utworzenie zadania wymaga callbacku | Obsługiwane bezpieczne potwierdzenie albo jawnie ograniczona funkcjonalność przykładu |
| R6 | P2 | `examples/extensions/mattermost/src/index.ts:48` | 101 postów z tym samym czasem; każda strona powtarza pierwsze 100 | Wszystkie zdarzenia i kolejne późniejsze są osiągalne, także po restarcie |
| R7 | P2 | `packages/web/src/routes/settings/chat-setup-help.tsx:47`, `lib/chat-providers/extension.ts:18` | Provider Mattermost otrzymuje instrukcje Discorda i komendy z ukośnikiem zamiast deklarowanego prefiksu | Testy pomocy i komend providera zewnętrznego |
| R8 | P2 | `packages/web/src/components/extensions/form.tsx:23,46,51` | Refetch zmienia model, ale defaultValue i stan pól zachowują stare wartości; zapis wysyła stare dane | Obsłużone czyste/brudne pola, wartości kanoniczne po zapisie i czyszczenie hasła |
| R9 | P2 | `packages/web/src/components/extensions/command-dock.tsx:29` | A kończy po B i zastępuje jego wynik; dismiss nie blokuje późniejszej odpowiedzi | Test odwrotnej kolejności ukończeń i dismiss podczas wykonania |
| R10 | P2 | `docs/extensions.md:53` | Opis obiecuje kursory i checkpointy bundled eventów; implementacja ich nie ma | Dokumentacja rozróżnia deduplikację hosta, external receive cursor i okna utraty bundled |
| R11 | P3 | `.ai/specs/2026-11-07-extension-placements-v1.1.md:35` | Spec obiecuje przyjęcie nowego location przez stary strict parser | Opis zgodny z rzeczywistą kompatybilnością i BC |

Dodatkowa hipoteza UX: odtworzenie descriptor/setupApi przy zmianie listy rozszerzeń może uruchomić cleanup anulujący rozpoczęte parowanie (`integrations-section.tsx:252`, `telegram-wizard.tsx:150–158`). Potwierdzono zależności w kodzie, ale nie wykonano pełnej reprodukcji przepływu. Nie należy liczyć tego jako kolejnego równie mocno potwierdzonego błędu. Stare sformułowanie `.env.example` opisano osobno w §8.

Znane ograniczenie transportowe: Slack może potwierdzić envelope przed trwałym przyjęciem hosta, a sesja Discord Gateway nie przeżywa dowolnej awarii workera w sposób zapewniający pełne odtworzenie. Należy odróżnić zaakceptowany kompromis niezawodności od błędnej obietnicy w docs/extensions.

## 12. Dowody i plan niezależnej weryfikacji

| Sprawdzenie ostatniego przeglądu | Wynik i zakres |
| --- | --- |
| Pełne `npm test` na ocenianym commicie | exit 0, 976 plików zaliczonych i 2 pominięte; 14 925 testów zaliczonych, 6 pominiętych |
| Backend | 112 zestawów / 1499 testów; pełny typecheck wraz z buildem SDK/serwera i trzech bundled artifacts |
| Bezpieczeństwo | 142 pliki / 1600 testów chatu, rozszerzeń i webhooków |
| UX | 9 plików / 282 testy; dodatkowo 5 prób RTL/hook/descriptor potwierdzających błędy |
| Produkt/dokumentacja | Kontrola 208 stron, 13 testów SDK, 7 testów project-summary, build Mattermosta |
| Reprodukcje | Telegram blocked, wyciek stderr, anulowanie z rzeczywistym ExtensionHost, aktualizacja między dwoma procesami, dwa błędy Mattermosta i problemy komponentów UX |

Zestawy testów zachodzą na siebie; liczb nie należy sumować. Próby reprodukcyjne przechodzą wtedy, gdy zaobserwują błąd — nie są dowodem jego naprawy. Początkowe błędy zależności w worktree recenzentów odrzucono: źródła i dependency resolution skorygowano do wskazanego commita. Żaden potwierdzony problem nie opiera się na tamtych niepoprawnych uruchomieniach.

Historyczne 16 zestawów e2e przeszło przed późniejszym dodaniem bundled Telegrama; extensions e2e powtarzano przy V1.1. Nie są to świeże dowody działania nowej ścieżki Telegrama na ocenianym commicie. Nie wykonano testów z rzeczywistymi tokenami Slacka, Discorda, Telegrama ani Mattermosta. Zielony test katalogu lub fikcyjnego workera nie dowodzi działania adaptera platformowego.

Zalecany przebieg dla niezależnego specjalisty w osobnym checkout ocenianego SHA, z Node zgodnym z repozytorium, zależnościami z lockfile i izolowanym CEZ_HOME:

```sh
timeout 600 npm ci --ignore-scripts --no-audit --no-fund
timeout 300 npm run typecheck
timeout 900 npm test -- --maxWorkers=4
timeout 300 npm run test:unit
timeout 600 npm run build
timeout 600 npm run test:package
timeout 120 node docs/site/scripts/check.mjs
timeout 120 npm test -w @open-mercato/cezar-extension-sdk
timeout 600 npm run test:pack -w @open-mercato/cezar-extension-sdk
```

To instrukcja ponowienia, nie twierdzenie, że wszystkie powyższe komendy wykonano w ostatniej rundzie. Testy przeglądarkowe uruchamiać według `.agents/skills/e2e/SKILL.md`, `docs/e2e-verification.md` i `.ai/scripts/e2e-runner.sh`, po zbudowaniu aktualnego cockpitu. Sprawdzić wymagania runnera i modelu przed uruchomieniem. Używać fałszywych platform i syntetycznych sekretów.

Najważniejsze dodatkowe próby akceptacyjne to R1–R9 z tabeli oraz nieznany widok w zapisanym układzie, manifest sprzed V1.1, nowy manifest na starszym hoście, tryb hosted, CEZ_EXTENSIONS=0 i dwie instancje współdzielące CEZ_HOME. Test regresyjny musi zawodzić na ocenianym błędnym kodzie i przechodzić po naprawie.

## 13. Materiał źródłowy dla recenzenta

W repozytorium: `AGENTS.md`, `BACKWARD_COMPATIBILITY.md`, `docs/adding-chat-provider.md`, `docs/authoring-extensions.md`, `docs/extensions.md`, specyfikacje chatu, workerów i V1.1 w `.ai/specs/`. Specyfikacja opisuje zamiar; przy konflikcie należy ustalić zachowanie przez kod i reprodukcję.

Pełne raporty poprzedniego przeglądu znajdują się w katalogu drzewa zadania `.ai/cezar/dispatch/177e722f-75c3-4600-bad9-b84178c55da1/units/` w głównym checkout projektu: `2eb4173a/notes.md` (bezpieczeństwo), `28affe1d/notes.md` (architektura), `616ecf15/notes.md` (UX), `a3811c83/notes.md` (produkt). Są to lokalne materiały, nie pliki gwarantowane w klonie git. Tymczasowe skrypty reprodukcyjne w `/tmp` także nie są trwałym elementem repozytorium; tabela §11 podaje warunki ich odtworzenia bez tych plików.

Werdykt dla ocenianej wersji: spójny kierunek produktu i architektury, wymagane poprawki przed uznaniem przepływów za gotowe. Najpierw odbiór Telegrama i granice bezpieczeństwa, następnie aktualizacje między procesami, Mattermost i UX, a na końcu ujednolicenie opisów. Sam dokument nie naprawia tych problemów.

## 13. Aktualizacja po naprawach (2026-11-08)

Sekcje 1–12 pozostają historyczną oceną `7d1cbcf64`; nie należy przenosić ich
wyników testów na późniejsze commity. Poniżej mapa wdrożonych poprawek do ponownej
weryfikacji. Końcowa walidacja po połączeniu wszystkich gałęzi jest osobnym krokiem.

| Ustalenie | Implementacja i dowód regresji |
| --- | --- |
| R1 Telegram | `31b6c177d`: worker używa hostowego trwałego dziennika i przekazuje aktualizacje do przetwarzania; rzeczywisty zbudowany adapter sprawdza odbiór, odrzucenie przyjęcia, replay po restarcie, offset i username. |
| R2 sekrety w stderr | `88424cc84`, `13b963421`, `9e481c96c`: redakcja przed obcinaniem; testy rzeczywistego hosta obejmują granice chunków, linii i ogona. Diagnostyka ponad 64 KiB lub niezamknięta do 250 ms po exit jest pomijana w całości. Śmierć procesu zgłaszana jest natychmiast, niezależnie od potomków trzymających pipe. |
| R3 anulowanie | `f45da8625` dodaje opcjonalny kontekst operacji SDK; `f310f722` stosuje go w Mattermost przed każdym fetch i przekazuje abort. Testy obejmują cofnięcie dostępu podczas przygotowania i izolację równoległych operacji. Stare adaptery wymagają adopcji; rozpoczętego efektu sieciowego nie można cofnąć. |
| R4 wiele procesów | `640bd0b48`, `c486ead1b`: uzgadnianie katalogu/uprawnień i przypinanie używanych artefaktów przez PID. `13b963421` przywraca łagodne zachowanie dla niezapisywalnego home. Testy uruchamiają dwa procesy oraz sprawdzają readonly boot bez uruchamiania nieprzypiętych workerów. |
| R5–R6 Mattermost | `ef938b914`, `dbabaf3f`: tekstowe potwierdzenia zachowują core capability i powiązanie użytkownik/chat/receipt; trwałe strony obejmują remisy timestampów. Cały catch-up kanału jest sortowany przed nadaniem sekwencji. Testy realnego core dowodzą Cancel przed Confirm także między stronami. Nie jest to globalna chronologia między kanałami ani snapshot platformy. |
| R7–R9 i reset parowania | `3390e20f4`: opis i prefiksy właściwego providera, odświeżanie formularzy z ochroną zmian użytkownika, czyszczenie haseł, odrzucanie spóźnionych wyników komend i stabilna tożsamość API parowania. Hipoteza resetu z §11 została potwierdzona testem regresji. |
| R10–R11 dokumentacja | `c5d23d83f`, `801790b48`, `c8b87573d`: rzeczywiste ograniczenia odbioru i replay, odrzucanie nowych manifestów przez starsze hosty, wymagania kursora, anulowanie i pliki leases. |

Poprawki miały niezależne przeglądy: backend `e5f9ec0c` zaakceptował
`9e481c96c`, chronologię Mattermost `ca37db2f` zaakceptował na `dbabaf3f`,
a adopcję anulowania `ed5c160b` na `f310f722`. Wcześniejsze odrzucenia wykryły
odwrócenie Cancel/Confirm, częściowy wyciek sekretu, regresję readonly home i
oczekiwanie na EOF zamiast śmierci workera; ich wersji nie należy uznawać za końcowe.
Nie wykonano testów na prawdziwych kontach platformowych.

### Walidacja po scaleniu poprawek

Na połączonej gałęzi (implementacja do `07001f369`, późniejsze zmiany tylko
w dokumentacji i testowych symulatorach) wykonano:

- `npm run typecheck`: wszystkie pakiety, exit 0.
- `npm test -- --maxWorkers=4`: 980 plików zaliczonych, 2 pominięte;
  14 963 testy zaliczone, 6 pominiętych, bez nieobsłużonych błędów.
- `npm run test:unit`: 50/50; `npm run build` i `check:pack`: sukces, 1470 plików.
- `NPM_CONFIG_USERCONFIG=/dev/null npm run test:package`: 34/34.
- Mattermost: 9/9 testów adaptera/anulowania i 8/8 testów z rzeczywistym core.
- SDK `test:pack`: trzy sprawdzenia zaliczone, w tym rzeczywisty worker
  z zainstalowanej paczki i przykłady kompilowane poza workspace.
- Kontrola dokumentacji: 208 stron, bez błędów.
- E2e: 15 konfiguracji przeszło w pełnym przebiegu; szesnasta (`extensions`)
  przeszła po poprawce symulatora Mattermost, który nie zwracał `order` ani stron.
  Symulator odzwierciedla teraz używany format odpowiedzi. Scenariusz obejmuje
  instalację, parowanie, restart, wyłączenie i odinstalowanie przez UI.

Test pakowania SDK również ujawnił nieaktualną atrapę (brak `storage` potrzebnego
trwałemu kursorowi). Zastąpiono ją utrzymywanymi testami adaptera i anulowania,
uruchamianymi na publicznej paczce SDK poza workspace; powtórzenie przeszło.
Nie były to naprawy adaptera pod osłabione asercje: poprawiono kontrakt symulatora
oraz wykorzystano szerszy zestaw istniejących testów.

Końcowa ocena: R1–R11 i potwierdzony reset parowania mają wdrożone poprawki
z weryfikacją. Ograniczenia opisane powyżej — kooperacyjne anulowanie, niepewność
rozpoczętych efektów sieciowych, granice replay platform i brak prób na żywych
kontach — pozostają jawne. Wyniki nie stanowią gwarancji braku innych błędów.
