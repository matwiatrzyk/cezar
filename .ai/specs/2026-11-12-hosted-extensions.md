# Rozszerzenia i czat w trybie hosted

Status: propozycja do implementacji. Specyfikacja nie zmienia obecnego zachowania.
Data: 2026-11-12. Zastępuje wcześniejszy wariant z administracją przez CLI i prywatnym IPC.

## Cel

Cezar uruchomiony na serwerze (`CEZ_REMOTE=1` albo bind na adres inny niż loopback) ma móc
instalować, włączać i uruchamiać rozszerzenia oraz boty czatu tak samo jak cockpit lokalny:
przez panel, istniejącymi ekranami i kreatorami. Boty i workery działają stale, także przy
zamkniętej przeglądarce, i wracają po restarcie serwera.

Operator serwera włącza to jawnie jedną flagą. Bez niej hosted zachowuje się dokładnie jak dziś.

## Model zaufania

Użytkownik wpuszczony do cockpitu hosted już dziś może zlecić agentowi zadanie z nieograniczonym
Bashem jako użytkownik systemowy cezara. Rozdzielanie „kto może uruchomić rozszerzenie” od „kto
może uruchomić agenta” nie daje więc realnej ochrony, a kosztuje osobny kanał administracyjny.

Dlatego: **kto ma dostęp do panelu hosted z włączoną flagą, ten może instalować i włączać
rozszerzenia oraz konfigurować boty i nadawać osobom sterowanie przez czat.** Decyzję, że tak ma
być na danym serwerze, podejmuje operator maszyny, ustawiając flagę.

Flaga nie jest domyślnie włączona, bo równanie „panel = shell” nie zawsze zachodzi: operator może
ograniczyć narzędzia agentów (`allowedTools`, `bashAllowlist`), a rozszerzenie działa trwale,
poza historią zadań. Ten sam wzór stosują już `CEZ_TERMINAL=1` i `CEZ_REMOTE_AGENT_ACCOUNTS=1`.

Bez zmian: hosted nadal wymaga uwierzytelnionego reverse proxy lub tunelu; osobny worker izoluje
awarie, nie złośliwy kod; zgoda per projekt ogranicza API hosta, nie dostęp do plików i sieci.

## Flaga

`CEZ_REMOTE_EXTENSIONS=1` — w trybie hosted dopuszcza rozszerzenia i czat w pełnym lokalnym
zakresie. Ustawiona w trybie lokalnym nic nie zmienia. Odczytywana przy starcie (jak `CEZ_DISPATCH`):
od niej zależy, które projekty serwer otwiera przy boot.

Pozostałe flagi działają jak dziś i nie są przez nią zastępowane:

| Flaga | Znaczenie w hosted z `CEZ_REMOTE_EXTENSIONS=1` |
| --- | --- |
| `CEZ_EXTENSIONS=0` | Wyłącza zainstalowane rozszerzenia jak lokalnie. Fallback in-process dla dostarczonych adapterów działa jak lokalnie. |
| `CEZ_WEBHOOKS=1` | Nadal wymagane dla powiadomień i botów. |
| `CEZ_CHAT_INBOUND=1` | Nadal wymagane dla sterowania zadaniami z czatu. |

Zmiana dotyczy `.env.example` i tabeli env w `docs/reference.md` w tym samym commicie. Flaga
poszerza ekspozycję, więc zostaje opt-in i nie wymaga wyjątku w AGENTS.md § Zero config.

## Co dziś blokuje hosted (stan kodu na `5f820de88`)

Rozszerzenia mają jedną bramkę, czat kilka rozproszonych sprawdzeń `mode !== 'local'`:

- `server/capabilities.ts` — `extensionsOffReason(env, localHandoff)`: jedno źródło dla capability
  `extensions` i dla tras. Trasy dodatkowo dostają `discloseInventory = localHandoff`
  (`extensionRoutes`, `globalExtensionRoutes` w `server.ts`).
- `chat/availability.ts` — `chatUnavailableReason(mode)` i `chatNotificationsUnavailableReason(mode)`.
- `chat/host.ts` — `start()` oraz cztery sprawdzenia w dostarczaniu i zarządzaniu (`mode !== 'local'`,
  m.in. `'Chat is local only'`).
- `chat/service.ts` — odmowa inbound przy `mode !== 'local'`.
- `webhooks/service.ts` — `chatManagementOnly` odrzuca hosted (`'Chat management is local only'`).
- `extensions/project-runtime.ts` — właściciel zarządzania czatem ma na sztywno `mode: 'local'`.
- `packages/web/src/api/extensions.ts` — `useExtensionSubscription` zakłada, że „extensions on
  oznacza cockpit lokalny” i subskrybuje WebSocket; tak samo `lib/chat-providers/*`
  (`*-inbound` topics).

`mode: 'local' | 'hosted'` służy jednak także do rzeczy, które mają zostać hosted-owe: linków do
cockpitu w powiadomieniach (`webhooks/payload.ts`, renderery providerów, `webhooks/links.ts`) i
polityki adresów webhooków (`webhooks/destination.ts`: https i publiczny adres w hosted).

## Zmiany

### 1. Jedna bramka zamiast `mode`

Wprowadzić jedną funkcję w `capabilities.ts`, np. `extensionsRuntimeAllowed(env, localHandoff)`:
lokalnie zawsze tak, w hosted tylko z `CEZ_REMOTE_EXTENSIONS=1`. `extensionsOffReason`,
`discloseInventory` i obie funkcje z `chat/availability.ts` czytają tę bramkę.

Sprawdzenia `mode !== 'local'` w `chat/host.ts`, `chat/service.ts` i `webhooks/service.ts`
zastąpić tą samą bramką (wstrzykiwaną jako zależność, nie czytaną z env w każdym module).
`mode` zostaje wyłącznie do linków i polityki adresów. Grep po `mode !== 'local'` i
`mode === 'hosted'` musi po zmianie pokazywać tylko te dwa zastosowania.

Ścieżki budowy `ChatHost`, `ChatInbound`, `WebhookService` i `ExtensionManager` (boot, leniwe
otwarcie projektu, kontynuacja, restart, właściciel zarządzania z `project-runtime.ts`) dostają
bramkę w tym samym commicie — AGENTS.md § „Find every construction site”.
`project-runtime.ts` przestaje ustawiać `mode: 'local'` na sztywno i przekazuje rzeczywisty tryb.

Bez flagi w hosted wszystkie odmowy zostają jak dziś (te same kody i komunikaty), łącznie z 409
na instalacji i zarządzaniu.

### 2. Praca w tle bez przeglądarki

Dziś projekt startowy jest przywracany przy boot (`restoreProjectExtensions(bootContext)`,
`webhooks.attach(bootContext, …)` w `server.ts`), a pozostałe zarejestrowane projekty dopiero przy
pierwszym zbudowaniu ich kontekstu (`ProjectContexts` jest leniwy). W hosted wieloprojektowym bot
projektu, którego nikt nie otworzył po restarcie, nie wstaje.

Przy starcie, gdy bramka pozwala, serwer buduje kontekst każdego zarządzanego projektu, który ma
włączone rozszerzenie albo aktywnego bota, odczytując to z istniejącego stanu na dysku (bez
uruchamiania kodu). Pozostałe projekty pozostają leniwe. Brak lub niedostępny katalog jednego
projektu jest logowany i nie blokuje pozostałych ani startu. Używamy zwykłego `ProjectContexts`
i istniejących limitów zasobów — bez drugiego menedżera.

To samo zachowanie warto rozważyć lokalnie (dziś też dotyczy go ta luka), ale nie jest warunkiem
tej specyfikacji; lokalny default zostaje bez zmian, chyba że osobna decyzja.

### 3. Instalacja z lokalnego folderu

W hosted ścieżka wskazuje katalog na serwerze. Instalacja z folderu jest dopuszczona tylko wewnątrz
`CEZ_BROWSE_ROOT`, z tą samą kontrolą dowiązań co przeglądarka folderów i konta agentów
(`hostedBrowseRoot` w `server.ts`). Bez `CEZ_BROWSE_ROOT` w hosted dostępna jest tylko instalacja z npm.

Inventory w hosted nie ujawnia absolutnych ścieżek spoza `CEZ_BROWSE_ROOT` (przycinanie jak
`trimPaths` dla innych odpowiedzi).

### 4. Odświeżanie w cockpicie hosted

Cockpit hosted nie otwiera WebSocketu. Zmiany rozszerzeń i stanu konfiguracji czatu muszą dotrzeć
istniejącym SSE workspace (`/api/v1/workspace/events`): serwer emituje zdarzenie o zmianie
rozszerzeń / czatu danego projektu (z tym samym debounce co temat WS: 250 ms i 1 s), a klient
unieważnia tylko zapytania tego projektu. `useExtensionSubscription` i `lib/chat-providers/*`
wybierają kanał według trybu: WS lokalnie, SSE w hosted. Po reconnect SSE obowiązuje zwykły
refetch. Nie wracamy do globalnej invalidacji przy każdej zmianie runu.

Nowe zdarzenie SSE ma schemat w `packages/contract` (parity, typed bodies).

### 5. Capabilities i UI

`capabilities.extensions` w hosted z flagą jest `true`; bez flagi zostaje `false` z
`extensionsUnavailableReason: 'hosted'`. Komunikat UI dla tego przypadku wskazuje flagę
(„Ustaw `CEZ_REMOTE_EXTENSIONS=1` na serwerze i uruchom cezar ponownie”), zamiast obecnego
„zainstaluj na maszynie z cezarem”. Ekrany Settings → Extensions i Integrations działają jak
lokalnie; nie powstają osobne widoki hosted.

Odpowiedzi czatu i rozszerzeń nie zawierają sekretów (bez zmian), a ostrzeżenia, które kreatory
czatu pokazują przy przyznawaniu sterowania, zostają takie same.

## Poza zakresem

RBAC i role w panelu; administracja przez CLI i prywatne IPC; sandbox dla niezaufanego kodu;
odrębna zgoda „hosted” obok zgody per projekt; zmiany SDK lub ABI rozszerzeń (§6b); zmiany
custom webhooków i ich polityki adresów; obsługa Windows ponad to, co działa lokalnie.

## Dokumentacja

- `docs/reference.md`, `.env.example`: `CEZ_REMOTE_EXTENSIONS` z ostrzeżeniem: bez logowania przed
  cezarem każdy, kogo wpuści proxy, może uruchomić kod na serwerze i przyznać osobom sterowanie
  agentami przez czat.
- Strony dokumentacji rozszerzeń i integracji czatu: sekcja „Na serwerze”, w tym przywracanie po
  restarcie i ograniczenie instalacji z folderu.
- `AGENTS.md`, tabela Extensions: „a hosted cockpit always refuses install/enable/disable/invoke
  (409)” zmienić na „…unless `CEZ_REMOTE_EXTENSIONS=1`”. To samo w akapicie Zero config o
  rozszerzeniach i w `BACKWARD_COMPATIBILITY.md`, jeśli opisuje odmowę hosted.

## Kryteria akceptacji

1. **Default bez zmian.** Lokalnie wszystko jak dziś. Hosted bez flagi: te same 409, zero workerów,
   zero botów, zero żądań do npm i komunikatorów — test na trasach, capabilities i runtime.
2. **Hosted z flagą = lokalnie.** Instalacja z npm, zgoda, włączenie, panele, paleta, widok zadania,
   formularze, odinstalowanie (keep/remove data, „Missing”) działają przez HTTP jak lokalnie.
3. **Czat w hosted.** Kreator Telegrama, Slacka i Discorda konfiguruje bota od zera, parowanie,
   granty i sterowanie działają na lokalnych fixture'ach providerów; `CEZ_WEBHOOKS` i
   `CEZ_CHAT_INBOUND` zachowują swoje znaczenie. Linki do cockpitu w powiadomieniach i polityka
   adresów webhooków dalej zależą od trybu hosted.
4. **Restart bez przeglądarki.** Po restarcie serwera boty i workery projektów z włączonymi
   rozszerzeniami wracają bez żadnego żądania HTTP, także dla projektu innego niż startowy.
   Niedostępny katalog jednego projektu nie zatrzymuje pozostałych.
5. **Folder.** Instalacja z folderu poza `CEZ_BROWSE_ROOT` (także przez dowiązanie) jest odrzucona;
   bez `CEZ_BROWSE_ROOT` w hosted dostępne jest tylko npm.
6. **SSE.** Cockpit hosted aktualizuje rozszerzenia i stan czatu bez WebSocketu; zmiana runu nie
   unieważnia zapytań rozszerzeń.
7. **Jedna bramka.** Po zmianie żaden moduł czatu ani rozszerzeń nie decyduje o dostępności przez
   `mode`; test pilnuje, że `mode` czytają tylko linki i polityka adresów.
8. Każdy nowy test granicy ma kontrolę negatywną (po usunięciu bramki/zmiany test nie przechodzi).
   Końcowe bramki: typecheck, `npm test`, `test:unit`, build z `check:pack`, `test:package`,
   `test:e2e:runner` z wariantem hosted dla `extensions` i jednego providera czatu, `docs:check`.

## Etapy

1. Bramka w `capabilities.ts`, zastąpienie sprawdzeń `mode` w czacie i webhookach, `project-runtime.ts`;
   testy macierzy local / hosted / hosted+flaga.
2. Przywracanie projektów z włączonymi rozszerzeniami i botami przy starcie.
3. Instalacja z folderu w hosted i przycinanie ścieżek.
4. Zdarzenie SSE, kanał w cockpicie, komunikaty UI.
5. Dokumentacja, `.env.example`, e2e hosted, przegląd.

Etapy 1–2 są zależne; 3 i 4 mogą iść równolegle po 1.
