# Rozszerzenia i czat w trybie hosted

Status: zrealizowane, jeszcze niewydane. Kryteria 8 (wariant
hosted w runnerze e2e) i 10 (scenariusz od początku do końca) nie mają automatycznego testu —
zob. „Ograniczenia”.

## Cel

Cezar uruchomiony na serwerze (`CEZ_REMOTE=1` albo bind na adres inny niż loopback) może
instalować, włączać i uruchamiać rozszerzenia oraz boty czatu tak samo jak cockpit lokalny: przez
panel, tymi samymi ekranami i kreatorami. Boty i workery działają stale, także przy zamkniętej
przeglądarce, i wracają po restarcie serwera.

Operator serwera włącza to jawnie jedną flagą. Bez niej hosted odmawia rozszerzeń i czatu.

## Model zaufania

Przy domyślnym, nieograniczonym dostępie agenta do Basha użytkownik cockpitu może już uruchamiać
kod jako użytkownik systemowy cezara, więc osobna administracja (np. przez CLI) nie tworzyłaby
granicy ochrony przed nim. Nie zakładamy jednak, że każdy deployment pozwala agentom na taki
dostęp.

Dlatego: **kto ma dostęp do panelu hosted z włączoną flagą, ten może instalować i włączać
rozszerzenia oraz konfigurować boty i nadawać osobom sterowanie przez czat.** Decyzję podejmuje
operator maszyny, ustawiając flagę. Każdy użytkownik panelu jest wtedy zaufanym administratorem
rozszerzeń tej instancji, także wspólnego inventory. Ten model nie służy do współdzielenia
instancji przez osoby o różnych poziomach zaufania. Uwierzytelnienie na proxy kontroluje wejście,
ale nie wprowadza ról wewnątrz Cezara.

Flaga nie jest domyślnie włączona, bo równanie „panel = shell” nie zawsze zachodzi: operator może
ograniczyć narzędzia agentów (`allowedTools`, `bashAllowlist`), a rozszerzenie działa trwale, poza
historią zadań. Ten sam wzór stosują `CEZ_TERMINAL=1` i `CEZ_REMOTE_AGENT_ACCOUNTS=1`.

Niezmiennie: hosted wymaga uwierzytelnionego reverse proxy lub tunelu; osobny worker izoluje
awarie, nie złośliwy kod; zgoda per projekt ogranicza API hosta, nie dostęp do plików i sieci.

## Flaga

`CEZ_REMOTE_EXTENSIONS=1` — w trybie hosted dopuszcza rozszerzenia i czat w pełnym lokalnym
zakresie. W trybie lokalnym nic nie zmienia. Odczytywana z `process.env` przy każdym sprawdzeniu;
env działającego procesu się nie zmienia, więc zmiana wartości działa po restarcie.

Po restarcie bez flagi w hosted nie startuje żaden worker rozszerzenia ani adapter czatu, również
przez fallback in-process; API odmawia zarządzania i wywołań. Zwykłe zamknięcie serwera sprząta
jego workery i połączenia. Wyłączenie flagi nie anuluje zadań wcześniej utworzonych przez bota.

Instalacje, konfiguracja, sekrety, zgody i uprawnienia osób pozostają zapisane. Po ponownym
włączeniu i restarcie wracają tylko wcześniej włączone, nadal poprawnie zatwierdzone artefakty i
aktywne połączenia. Zmieniony artefakt lub poszerzone uprawnienia wymagają zwykłej ponownej zgody;
flaga nie omija weryfikacji integralności.

Pozostałe flagi działają tak samo i nie są przez nią zastępowane:

| Flaga | Znaczenie w hosted z `CEZ_REMOTE_EXTENSIONS=1` |
| --- | --- |
| `CEZ_EXTENSIONS=0` | Wyłącza zainstalowane rozszerzenia jak lokalnie; dostarczone adaptery działają przez fallback in-process jak lokalnie. |
| `CEZ_WEBHOOKS=1` | Wymagane dla powiadomień i botów. |
| `CEZ_CHAT_INBOUND=1` | Wymagane dla sterowania zadaniami z czatu. |

Flaga poszerza ekspozycję, więc jest opt-in (AGENTS.md § Zero config) i jest opisana w
`.env.example` oraz w tabeli env w `docs/reference.md`.

## Projekt

### 1. Jedna bramka zamiast `mode`

`extensionsRuntimeAllowed(env, localHandoff)` w `server/capabilities.ts`: lokalnie zawsze tak, w
hosted tylko z `CEZ_REMOTE_EXTENSIONS=1`. Czytają ją `extensionsOffReason`, `discloseInventory`
tras rozszerzeń oraz `chatUnavailableReason` / `chatNotificationsUnavailableReason`
(`chat/availability.ts`). `ChatHost`, `ChatInbound`, `WebhookService`, `ExtensionManager` i
właściciel zarządzania czatem (`extensions/project-runtime.ts`) dostają ją jako zależność
(`runtimeAllowed`), nie czytają env w każdym module. Wszystkie ścieżki budowy (boot, leniwe
otwarcie projektu, kontynuacja, restart) przekazują ją w tym samym miejscu — AGENTS.md § „Find
every construction site”.

`mode: 'local' | 'hosted'` nadal opisuje rzeczywisty tryb i steruje tym, co ma pozostać hosted:
linkami do cockpitu w powiadomieniach (`webhooks/payload.ts`, renderery providerów,
`webhooks/links.ts`) i polityką adresów webhooków (`webhooks/destination.ts`: https i publiczny
adres w hosted). W żądaniu dostarczenia `policy.mode` jest wyłącznie polityką adresów (łącznie z
zapisanym trybem aktywacji odbiornika), a dostępność czatu idzie osobnym polem z bramki.

**Dlaczego bramka, a nie usunięcie warunków `mode`:** ten sam `mode` niesie politykę adresów i
linków, która w hosted musi zostać hosted; tylko dostępność runtime'u zależy od flagi.

Bez flagi w hosted odmowy mają stałe kody i komunikaty, łącznie z 409 na instalacji i
zarządzaniu (komunikat wskazuje `CEZ_REMOTE_EXTENSIONS=1`).

### 2. Praca w tle bez przeglądarki

- Boty wracają bez kontekstu projektu. `WebhookCoordinator.start()` uruchamia `discover()` przy
  boot i co 15 s. Dla każdego zarejestrowanego, dostępnego projektu z plikiem
  `.ai/cezar/webhooks/endpoints.json` otwiera `WebhookService`, który przytrzymuje
  `ExtensionManager` projektu, deklaruje dostarczone adaptery i woła `startChat()`.
  `CEZ_SINGLE_PROJECT=1` ogranicza to do projektu startowego. Niedostępny katalog projektu
  (`status === 'missing'`) jest pomijany.
- Każdy projekt otwiera się i startuje czat na własnym łańcuchu: zawieszone otwarcie jednego
  projektu nie zatrzymuje pozostałych. Dotyczy to także trybu lokalnego.
- Polecenie z czatu samo buduje kontekst projektu (`contexts.context(project.id)`);
  `ProjectContexts` współdzieli budowę w locie, więc równoczesne wejście użytkownika nie tworzy
  drugiego kontekstu.
- Rozszerzenia bez czatu i recovery zadań startują z kontekstem projektu (`onBeforeRecover`).

Nie ma kolejki startowej ani anulowania budowy kontekstu: `ProjectContexts.build()` nie przyjmuje
sygnału, a aktywacja pojedynczego workera jest już ograniczona (10 s).

### 3. Instalacja z lokalnego folderu

W hosted ścieżka wskazuje katalog na serwerze. Instalacja z folderu jest dopuszczona tylko wewnątrz
katalogu przeglądania z „Add project” (domyślnie `~/`, zapisana wartość workspace lub
`CEZ_BROWSE_ROOT`) — `hostedSourcePolicy` w `server/extensions.ts`.

Kontrola rozwiązuje rzeczywistą ścieżkę (`realpath`) bazy i źródła oraz sprawdza przynależność po
segmentach ścieżki, nie tekstowym prefiksem: `/srv/plugins-other` nie należy do `/srv/plugins`.
Dowiązanie poza bazę, nieistniejąca lub niedostępna baza/ścieżka oznaczają odmowę. Kontrola
obowiązuje w API podglądu, instalacji i aktualizacji, przed odczytem paczki, niezależnie od
selektora w UI. Kopiowanie nie podąża za wewnętrznymi dowiązaniami poza bazę. Odrzucone źródło nie
uruchamia kodu ani instalacji.

Inventory w hosted nie ujawnia absolutnych ścieżek spoza tego katalogu
(`trimHostedExtensionSource`).

### 4. Odświeżanie w cockpicie hosted

Cockpit hosted nie otwiera WebSocketu. Zmiany rozszerzeń i konfiguracji czatu docierają przez SSE
workspace (`/api/v1/workspace/events`) jako zdarzenia `extension-inventory-changed` i
`chat-configuration-changed` z ładunkiem `{ changed: true }` (schemat
`hostedConfigurationChangedEventSchema` w `packages/contract/src/events.ts`). Serwer łączy
zdarzenia danego typu w jedno co 250 ms. Klient unieważnia zapytania rozszerzeń
(`['extensions']`) albo konfiguracji czatu wszystkich projektów; zmiana runu niczego tu nie
unieważnia. Po każdym ponownym zestawieniu połączenia SSE obowiązuje zwykły refetch, więc zmiana
podczas zerwania jest widoczna bez replay. Zdarzenia nie niosą sekretów ani identyfikatorów
projektu. `useExtensionSubscription` i `lib/chat-providers/*` wybierają kanał według trybu: WS
lokalnie, SSE w hosted.

### 5. Capabilities i UI

`capabilities.extensions` w hosted z flagą jest `true`; bez flagi `false` z
`extensionsUnavailableReason: 'hosted'`, a UI wskazuje flagę („Set `CEZ_REMOTE_EXTENSIONS=1` on the
server and restart cezar”). Settings → Extensions i Integrations działają jak lokalnie; nie ma
osobnych widoków hosted. Odpowiedzi czatu i rozszerzeń nie zawierają sekretów, a ostrzeżenia
kreatorów czatu przy przyznawaniu sterowania są takie same jak lokalnie.

## Poza zakresem

RBAC i role w panelu; osobna administracja przez CLI lub prywatne IPC; sandbox dla niezaufanego
kodu; odrębna zgoda „hosted” obok zgody per projekt; zmiany SDK lub ABI rozszerzeń (§6b); zmiany
custom webhooków i ich polityki adresów; obsługa Windows ponad to, co działa lokalnie.

## Ograniczenia

- Rozszerzenie bez czatu w projekcie, którego nikt nie otworzył po restarcie, nie działa do
  pierwszego żądania HTTP albo polecenia z czatu dla tego projektu. Jego panele, komendy i
  zdarzenia zadań i tak wymagają kontekstu; tracona jest tylko jego własna praca w tle. Lokalnie
  jest tak samo.
- Zdarzenia SSE nie niosą projektu (źródła `ExtensionManager.subscribe` i
  `WebhookCoordinator.onChatChange` go nie przekazują), więc cockpit z wieloma projektami robi
  nadmiarowy refetch.
- Runner e2e nie ma wariantu hosted (`extensions` i jeden provider czatu z `CEZ_REMOTE=1` i
  `CEZ_REMOTE_EXTENSIONS=1`), którego wymaga kryterium 8.
- Scenariusz z kryterium 10 nie ma automatycznego testu od początku do końca.

## Kryteria akceptacji

1. **Default.** Lokalnie bez zmian. Hosted bez flagi: 409, zero workerów, zero botów, zero żądań
   do npm i komunikatorów — testy tras, capabilities i runtime.
2. **Hosted z flagą = lokalnie.** Instalacja z npm, zgoda, włączenie, panele, paleta, widok
   zadania, formularze, odinstalowanie (keep/remove data, „Missing”) działają przez HTTP jak
   lokalnie.
3. **Czat w hosted.** Kreator Telegrama, Slacka i Discorda konfiguruje bota od zera; parowanie,
   granty i sterowanie działają na lokalnych fixture'ach providerów; `CEZ_WEBHOOKS` i
   `CEZ_CHAT_INBOUND` zachowują znaczenie. Linki do cockpitu i polityka adresów webhooków zależą od
   trybu hosted.
4. **Restart bez przeglądarki.** Po restarcie boty wracają bez żądania HTTP, także dla projektu
   innego niż startowy. Niedostępny katalog, błąd workera lub zawieszone otwarcie jednego projektu
   nie zatrzymuje botów pozostałych ani HTTP. Polecenie z czatu i równoczesne wejście użytkownika
   dają jeden kontekst i jednego bota.
5. **Folder.** Instalacja z folderu poza katalogiem przeglądania (także przez dowiązanie) jest
   odrzucona. Testy obejmują poprawny folder, podobny prefiks, dowiązanie źródła i wewnątrz paczki
   poza bazę, niedostępną bazę, aktualizację z zapisanego źródła oraz bezpośrednie żądanie API.
6. **SSE.** Cockpit hosted aktualizuje rozszerzenia i stan czatu bez WebSocketu; zmiana runu nie
   unieważnia zapytań rozszerzeń; zmiana podczas zerwanego połączenia jest widoczna po reconnect.
7. **Macierz zachowań.** Testy tras, capabilities i runtime obejmują local, hosted bez flagi,
   hosted z flagą oraz kombinacje `CEZ_EXTENSIONS`, `CEZ_WEBHOOKS` i `CEZ_CHAT_INBOUND`, dostarczony
   fallback i właściciela zarządzania czatem. Testujemy skutki, nie liczbę wystąpień `mode`.
8. Każdy test granicy ma kontrolę negatywną. Bramki: typecheck, `npm test`, `test:unit`, build z
   `check:pack`, `test:package`, `docs:check`, oraz — ręcznie przed wydaniem — `test:e2e:runner`
   z wariantem hosted dla `extensions` i jednego providera czatu (wariantu jeszcze nie ma).
9. **Wyłączenie i ponowne włączenie.** Restart bez flagi blokuje runtime i wywołania, zachowując
   dane i zgody. Restart z flagą przywraca poprawnie zatwierdzone integracje, nie omija zmiany
   integralności i nie włącza wcześniej wyłączonych pozycji.
10. **Scenariusz od początku do końca.** Bot w panelu hosted dla projektu innego niż startowy;
    zamknięta przeglądarka, restart serwera, brak żądań otwierających projekt; polecenie
    zatwierdzonej osoby przez fixture komunikatora tworzy zadanie dokładnie raz; panel pokazuje
    aktualny stan bota i zadania. Bez prawdziwego tokenu i zewnętrznego komunikatora.
