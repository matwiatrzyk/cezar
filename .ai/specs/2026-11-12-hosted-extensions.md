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

Przy domyślnym, nieograniczonym dostępie agenta do Basha użytkownik cockpitu może już dziś
uruchamiać kod jako użytkownik systemowy cezara. Osobna administracja przez CLI nie tworzy
wtedy granicy ochrony przed tym użytkownikiem. Nie zakładamy jednak, że każdy deployment
pozwala agentom na taki dostęp.

Dlatego: **kto ma dostęp do panelu hosted z włączoną flagą, ten może instalować i włączać
rozszerzenia oraz konfigurować boty i nadawać osobom sterowanie przez czat.** Decyzję, że tak ma
być na danym serwerze, podejmuje operator maszyny, ustawiając flagę. Każdy użytkownik panelu
jest wtedy zaufanym administratorem rozszerzeń tej instancji, także wspólnego inventory.
Ten model nie służy do współdzielenia instancji przez osoby o różnych poziomach zaufania.
Uwierzytelnienie na proxy kontroluje wejście, ale nie wprowadza ról wewnątrz Cezara.

Flaga nie jest domyślnie włączona, bo równanie „panel = shell” nie zawsze zachodzi: operator może
ograniczyć narzędzia agentów (`allowedTools`, `bashAllowlist`), a rozszerzenie działa trwale,
poza historią zadań. Ten sam wzór stosują już `CEZ_TERMINAL=1` i `CEZ_REMOTE_AGENT_ACCOUNTS=1`.

Bez zmian: hosted nadal wymaga uwierzytelnionego reverse proxy lub tunelu; osobny worker izoluje
awarie, nie złośliwy kod; zgoda per projekt ogranicza API hosta, nie dostęp do plików i sieci.

## Flaga

`CEZ_REMOTE_EXTENSIONS=1` — w trybie hosted dopuszcza rozszerzenia i czat w pełnym lokalnym
zakresie. Ustawiona w trybie lokalnym nic nie zmienia. Odczytywana przy starcie (jak `CEZ_DISPATCH`):
od niej zależy, które projekty serwer otwiera przy boot.

Usunięcie flagi lub ustawienie jej na `0` wymaga restartu. Po restarcie w hosted nie startuje
żaden worker rozszerzenia ani adapter czatu, również przez fallback in-process; API ponownie
odmawia zarządzania i wywołań. Zmiana env nie zatrzymuje działającego procesu w locie.
Zwykłe zamknięcie serwera sprząta jego workery i połączenia. Wyłączenie flagi nie anuluje
zadań wcześniej utworzonych przez bota.

Instalacje, konfiguracja, sekrety, zgody i uprawnienia osób pozostają zapisane. Po ponownym
włączeniu i restarcie wracają tylko wcześniej włączone, nadal poprawnie zatwierdzone artefakty
i aktywne połączenia. Zmieniony artefakt lub poszerzone uprawnienia nadal wymagają zwykłej
ponownej zgody; flaga nie omija weryfikacji integralności.

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
- `webhooks/service.ts` — `chatManagementOnly` odrzuca hosted (`'Chat management is local only'`),
  a `WebhookService.open` przytrzymuje `ExtensionManager` projektu i deklaruje dostarczone adaptery
  tylko przy `mode === 'local'`. Bez tej gałęzi bot w hosted nie ma workera.
- `chat/service.ts` — także `chatUnavailableReason(this.deps.mode)` w stanie dostępności i
  `ChatBindings` budowane z `mode`; w `server.ts` to samo dla `bindingDependencies.mode`.
- `extensions/project-runtime.ts` — właściciel zarządzania czatem ma na sztywno `mode: 'local'`.
- Dostarczanie czatu czyta tryb z `request.policy.mode`, a nie z opcji hosta. `webhooks/service.ts`
  ustawia go na `hosted`, gdy źródło albo **zapisana aktywacja odbiornika** ma `mode: 'hosted'`.
  Ta sama wartość steruje polityką adresów, więc bramka czatu i polityka adresów muszą dostać
  w żądaniu dwa osobne pola.
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
`mode` nadal opisuje rzeczywisty tryb, m.in. dla linków i polityki adresów. W żądaniu dostarczenia
`policy.mode` zostaje wyłącznie polityką adresów (łącznie z zapisanym trybem aktywacji odbiornika),
a dostępność czatu idzie osobnym polem z bramki. Przegląd warunków
trybu służy znalezieniu pominiętych blokad, ale testy nie narzucają liczby odczytów ani miejsc
występowania `mode`: sprawdzają zachowanie tras, capabilities i runtime.

Ścieżki budowy `ChatHost`, `ChatInbound`, `WebhookService` i `ExtensionManager` (boot, leniwe
otwarcie projektu, kontynuacja, restart, właściciel zarządzania z `project-runtime.ts`) dostają
bramkę w tym samym commicie — AGENTS.md § „Find every construction site”.
`project-runtime.ts` przestaje ustawiać `mode: 'local'` na sztywno i przekazuje rzeczywisty tryb.

Bez flagi w hosted wszystkie odmowy zostają jak dziś (te same kody i komunikaty), łącznie z 409
na instalacji i zarządzaniu.

### 2. Praca w tle bez przeglądarki

Stan kodu (zweryfikowany na `5f820de88`; wcześniejsza wersja tej sekcji błędnie zakładała, że
boty nieotwartych projektów nie wstają):

- **Boty wracają już dziś bez kontekstu projektu.** `WebhookCoordinator.start()` uruchamia
  `discover()` przy boot i co 15 s. Dla każdego zarejestrowanego, dostępnego projektu z plikiem
  `.ai/cezar/webhooks/endpoints.json` otwiera `WebhookService`, który sam przytrzymuje
  `ExtensionManager` projektu (`retainProjectExtensions`), deklaruje dostarczone adaptery i woła
  `startChat()`. Ten plik jest więc istniejącym kryterium „projekt ma integrację”; nowego odczytu
  stanu nie trzeba. `CEZ_SINGLE_PROJECT=1` ogranicza to do projektu startowego.
- **Polecenie z czatu samo buduje kontekst.** `chatInteractions.context` woła
  `contexts.context(project.id)`, a `ProjectContexts` współdzieli budowę w locie, więc równoczesne
  wejście użytkownika nie tworzy drugiego kontekstu.
- **Rozszerzenia bez czatu startują dopiero z kontekstem** (`onBeforeRecover` →
  `restoreProjectExtensions`). Tak samo recovery zadań.
- **`ProjectContexts` nie umie anulować budowy.** `build()` nie przyjmuje sygnału, a `shutdownAll`
  czeka na budowy w locie. Aktywacja pojedynczego workera jest już ograniczona
  (`ACTIVATE_TIMEOUT_MS`, 10 s).

Wniosek: **nie powstaje kolejka startowa ani timeout z anulowaniem budowy kontekstu.** Po zmianie
bramki z etapu 1 (w tym gałęzi `mode === 'local'` w `WebhookService.open`) boty wszystkich
projektów wracają w hosted istniejącą ścieżką. Etap 2 sprowadza się do:

1. Testów, które przypinają to zachowanie w hosted z flagą: bot projektu innego niż startowy
   wstaje bez żadnego żądania HTTP, a polecenie z czatu buduje kontekst dokładnie raz.
2. Sprawdzenia odporności `discover()`. Pętla otwiera projekty po kolei z `await`, a powtórne
   przebiegi czekają na to samo otwarcie w locie (`opening`). Zawieszone otwarcie jednego projektu
   mogłoby więc zatrzymać projekty po nim. Wymagany test z zawieszonym otwarciem; jeśli wyjdzie
   czerwony, otwarcia projektów w `discover()` stają się niezależne. Ta poprawka obejmuje też tryb
   lokalny, bo nie zmienia jego zachowania w przypadku bez awarii.
3. Niedostępny katalog projektu jest pomijany jak dziś (`status === 'missing'`).

Świadome ograniczenie: rozszerzenie bez czatu w projekcie, którego nikt nie otworzył po
restarcie, nie działa do pierwszego żądania HTTP albo polecenia z czatu dla tego projektu. Jego
panele, komendy i zdarzenia zadań i tak wymagają kontekstu; tracona jest tylko własna praca
rozszerzenia w tle. Lokalnie jest tak samo. Zmiana tego wymagałaby anulowalnej budowy kontekstu
i jest poza zakresem.

### 3. Instalacja z lokalnego folderu

W hosted ścieżka wskazuje katalog na serwerze. Instalacja z folderu jest dopuszczona tylko wewnątrz
`CEZ_BROWSE_ROOT`, z tą samą kontrolą dowiązań co przeglądarka folderów i konta agentów
(`hostedBrowseRoot` w `server.ts`). Baza to ten sam katalog przeglądania co w „Add project” (domyślnie
`~/`, zapisana wartość workspace lub `CEZ_BROWSE_ROOT`).

Kontrola rozwiązuje rzeczywistą ścieżkę (`realpath`) bazy i źródła oraz sprawdza przynależność
po segmentach ścieżki, nie tekstowym prefiksem: `/srv/plugins-other` nie należy do `/srv/plugins`.
Dowiązanie poza bazę, nieistniejąca lub niedostępna baza/ścieżka oznaczają odmowę. Kontrola
obowiązuje w API podglądu i instalacji, przed odczytem paczki, niezależnie od selektora w UI.
Przy kopiowaniu zawartości nie wolno podążać za wewnętrznymi dowiązaniami poza bazę.
Odrzucone źródło nie uruchamia kodu ani instalacji.

Inventory w hosted nie ujawnia absolutnych ścieżek spoza `CEZ_BROWSE_ROOT` (przycinanie jak
`trimPaths` dla innych odpowiedzi).

### 4. Odświeżanie w cockpicie hosted

Cockpit hosted nie otwiera WebSocketu. Zmiany rozszerzeń i stanu konfiguracji czatu muszą dotrzeć
istniejącym SSE workspace (`/api/v1/workspace/events`): serwer emituje zdarzenie o zmianie
rozszerzeń / czatu danego projektu (z tym samym debounce co temat WS: 250 ms i 1 s), a klient
unieważnia tylko zapytania tego projektu. `useExtensionSubscription` i `lib/chat-providers/*`
wybierają kanał według trybu: WS lokalnie, SSE w hosted. Po reconnect SSE obowiązuje zwykły
refetch: po każdym ponownym zestawieniu połączenia klient unieważnia aktywne zapytania inventory,
rozszerzeń i konfiguracji czatu, także bez replay zdarzeń. Nieaktywny widok pobiera aktualny stan
po otwarciu. Pierwsze połączenie również nie może zgubić zmiany między początkowym pobraniem
danych a subskrypcją. Zdarzenia niosą zakres zmiany, bez sekretów. Zmiana wspólnego inventory
odświeża inventory i dane dotkniętych projektów. Subskrypcja ma jednego właściciela i jest
sprzątana przy odmontowaniu; hosted nie otwiera przy tym żadnego WebSocketu.
Nie wracamy do globalnej invalidacji przy każdej zmianie runu. Istniejące odświeżanie paneli
zależnych od statusów zadań pozostaje zachowane.

Nowe zdarzenie SSE ma schemat w `packages/contract` (parity, typed bodies).

**Stan wdrożenia (2026-11-12).** Zdarzenia `extension-inventory-changed` i
`chat-configuration-changed` niosą dziś tylko `{ changed: true }`, a klient unieważnia zapytania
rozszerzeń i konfiguracji czatu wszystkich projektów. Źródła (`ExtensionManager.subscribe`,
`WebhookCoordinator.onChatChange`) nie przekazują projektu, więc zakres wymaga zmiany po ich
stronie — to osobny krok. Skutkiem jest wyłącznie nadmiarowy refetch w cockpicie z wieloma
projektami; zmiana runu nadal niczego tu nie unieważnia. Serwer łączy zdarzenia w jedno co
250 ms. Flaga `CEZ_REMOTE_EXTENSIONS` jest czytana z `process.env` przy każdym sprawdzeniu, co dla
działającego procesu daje ten sam skutek co odczyt przy starcie.

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
4. **Restart bez przeglądarki.** Po restarcie serwera boty wracają bez żadnego żądania HTTP, także
   dla projektu innego niż startowy. Niedostępny katalog, błąd workera lub zawieszone otwarcie
   jednego projektu nie zatrzymuje botów pozostałych ani HTTP. Polecenie z czatu i równoczesne
   wejście użytkownika dają jeden kontekst i jednego bota. Rozszerzenie bez czatu w nieotwartym
   projekcie startuje przy pierwszym żądaniu lub poleceniu dla tego projektu.
5. **Folder.** Instalacja z folderu poza `CEZ_BROWSE_ROOT` (także przez dowiązanie) jest odrzucona;
   baza jest tą samą co dla przeglądarki folderów (domyślnie `~/`). Testy obejmują poprawny folder,
   podobny prefiks, dowiązanie źródła i wewnątrz paczki poza bazę, niedostępną bazę oraz
   bezpośrednie żądanie API omijające selektor UI.
6. **SSE.** Cockpit hosted aktualizuje rozszerzenia i stan czatu bez WebSocketu; zmiana runu nie
   unieważnia globalnie zapytań rozszerzeń. Zmiana podczas zerwanego połączenia jest widoczna
   po reconnect bez ręcznego przeładowania i bez replay zdarzenia. Wcześniej nieaktywny widok
   pokazuje aktualny stan po otwarciu.
7. **Macierz zachowań.** Testy tras, capabilities i runtime obejmują local, hosted bez flagi,
   hosted z flagą oraz kombinacje `CEZ_EXTENSIONS`, `CEZ_WEBHOOKS` i `CEZ_CHAT_INBOUND`.
   Obejmują też dostarczony fallback i właściciela zarządzania czatem. Hosted z flagą zachowuje
   ograniczenia adresów webhooków (https i publiczny adres) oraz właściwe linki.
   Testujemy skutki, nie liczbę wystąpień `mode` w kodzie.
8. Każdy nowy test granicy ma kontrolę negatywną (po usunięciu bramki/zmiany test nie przechodzi).
   Końcowe bramki: typecheck, `npm test`, `test:unit`, build z `check:pack`, `test:package`,
   `test:e2e:runner` z wariantem hosted dla `extensions` i jednego providera czatu, `docs:check`.
9. **Wyłączenie i ponowne włączenie.** Restart bez flagi blokuje runtime i wywołania, zachowując
   dane i zgody. Kolejny restart z flagą przywraca poprawnie zatwierdzone integracje, ale nie
   omija zmiany integralności ani nie włącza wcześniej wyłączonych pozycji.
10. **Scenariusz od początku do końca.** Skonfigurować bota w panelu hosted dla projektu innego
    niż startowy. Zamknąć przeglądarkę, zrestartować serwer, nie wysyłać żądań otwierających
    ten projekt. Z zatwierdzonej osoby wysłać polecenie przez fixture komunikatora i potwierdzić
    obsługę/utworzenie zadania dokładnie raz. Otworzyć panel i sprawdzić aktualny stan bota
    i zadania. Automatyczny test nie wymaga prawdziwego tokenu ani zewnętrznego komunikatora.

## Etapy

1. Bramka w `capabilities.ts`, zastąpienie sprawdzeń `mode` w czacie i webhookach, `project-runtime.ts`;
   testy macierzy local / hosted / hosted+flaga.
2. Testy przywracania botów w hosted i odporność `discover()` na zawieszone otwarcie (§2).
3. Instalacja z folderu w hosted i przycinanie ścieżek.
4. Zdarzenie SSE, kanał w cockpicie, komunikaty UI.
5. Dokumentacja, `.env.example`, e2e hosted, przegląd.

Etapy 1–2 są zależne; 3 i 4 mogą iść równolegle po 1. Etap 2 jest mały, więc całość mieści się
w jednym PR-ze.

### E2E w trybie hosted

Runner tego nie ma, ale wariant jest tani. `extensions-server.mjs` i `chat-webhooks-server.mjs`
czyszczą wszystkie `CEZ_*` i ustawiają własne, a capabilities są czytane przy każdym żądaniu.
Wariant hosted to nowe configi (`extensions-hosted`, jeden provider czatu) z dodanymi
`CEZ_REMOTE=1` i `CEZ_REMOTE_EXTENSIONS=1`. Serwer nadal słucha na loopbacku, więc strażnik
`loopback-netguard` działa bez zmian. `extensions-server.mjs` ma już sterowanie `/restart`, którego
użyje scenariusz z kryterium 10. Specyfikacje hosted sprawdzają też, że przeglądarka nie otwiera
WebSocketu.
