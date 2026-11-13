# Niezależne wtyczki Telegram, Slack i Discord

Status: zrealizowane, jeszcze niewydane. Kod:
`packages/chat-plugins/{telegram,slack,discord}`, `packages/cezar/src/extensions/delivery-catalog.ts`,
`chat-selection*.ts`, `project-runtime.ts`, `manager.ts`, `host.ts`. Wspólny rdzeń czatu:
`2026-11-04-chat-providers.md`; system rozszerzeń: `2026-11-05-extension-system-design.md`.

## 1. Cel i granice

Telegram, Slack i Discord są trzema samodzielnymi pakietami rozszerzeń działającymi przez publiczne
SDK. Ten sam artefakt można zainstalować z folderu/paczki oraz dostać razem z Cezarem. Wyjęcie
paczki z repozytorium nie odbiera jej funkcji i nie wymaga importu prywatnych modułów hosta.

SDK ma `apiVersion: 0.1`, zmieniane wyłącznie addytywnie; miejsca wpięcia paneli i komend
(`2026-11-07-extension-placements-v1.1.md`) obowiązują bez zmian. Zmiana implementacji (dostarczona ↔ zainstalowana) zachowuje boty, sparowania, uprawnienia i
odbiorców bez ponownego setupu. Start Cezara nigdy nie pobiera pakietów z rejestru.

Ustawienia rozdzielają zarządzanie oprogramowaniem od konfiguracji projektu: globalne
**Extensions** zarządza wtyczkami, projektowe **Integrations** konfiguruje usługi, z kategoriami
jako filtrem. Jira, Linear i webhooki nie są wtyczkami i działają bez zmian.

Poza zakresem: marketplace, podpisy paczek, sandbox, zmiany produkcyjnych sekretów, gwarancje
dostarczania zdarzeń ponad to, co daje platforma. Proces Node nie jest granicą bezpieczeństwa
wobec złośliwej wtyczki. Próby na prawdziwych kontach są osobną czynnością.

## 2. Wymagania

1. Trzy pakiety z manifestem rozszerzenia, buildem, własnymi zależnościami, testami i README; bez
   importów prywatnego Cezara/kontraktu i ścieżek do monorepo.
2. Pakiet zainstalowany poza repozytorium komunikuje się z Cezarem wyłącznie przez publiczny
   kontrakt. Wersja dostarczona z Cezarem używa tego samego wejścia i API.
3. Dostarczenie z Cezarem to decyzja hosta o pochodzeniu i zaufaniu do artefaktu, nie osobna
   implementacja transportu ani prywatne API.
4. Identyfikatory providerów, stan, bot leases, zgody, trasy HTTP i ścieżki UI mają stałe
   znaczenie niezależnie od źródła artefaktu. Dla jednego bota istnieje dokładnie jeden aktywny
   odbiorca.
5. Wtyczka ma jedno miejsce zarządzania w Extensions, a połączenie jeden formularz w
   Integrations.

## 3. Podział odpowiedzialności

| Obszar | Wtyczka | Host Cezara |
| --- | --- | --- |
| Protokół platformy | HTTP, WebSocket, polling, reconnect, parsery, ACK platformowy | Limity i kontrola życia adaptera |
| Zdarzenia | Normalizacja do publicznego formatu, stabilne ID, kolejność | Trwałe przyjęcie, deduplikacja, dziennik i checkpoint |
| Zadania | Przekazuje zdarzenie; renderuje wynik | Parowanie, zgody osoby/czatu, Confirm, wybór projektu, wykonanie |
| Poświadczenia | Tylko uprawniony dostęp dla konkretnego bota/operacji | Vault, zakres sekretów, trwała rotacja, koordynacja między procesami |
| Życie procesu | Dispose, przerwanie I/O, zgłoszenie health | Restart/backoff, timeouty, fencing, jeden właściciel bota, artifact leases |
| UI i instalacja | Deklaratywne metadane setupu/prezentacji | Extensions dla pakietów, Integrations dla konfiguracji projektu |

Pakiety leżą w `packages/chat-plugins/<provider>` jako osobno budowalne projekty
(`@open-mercato/cezar-chat-<provider>`, identyfikatory rozszerzeń `open-mercato.<provider>`).
Logiczna tożsamość wtyczki jest stała i niezależna od miejsca instalacji artefaktu. Kod
współdzielony przez adaptery (`packages/chat-plugins/shared/`: przypięte żądania HTTP, wsparcie
adaptera) jest kopiowany do każdego pakietu (`shared/sync.mjs`), nie importowany z
`packages/cezar`.

## 4. Kontrakt SDK

Schematy, sygnatury, limity i przypadki odmowy: `packages/extension-sdk/src/chat.ts`.

### Odbiór i trwałość

- Jeden model odbioru: `receiveSession` dla zadeklarowanego `receiveModel` (`ordered` albo
  `opaque`) — start, stop/abort, health oraz potwierdzenie trwałego przyjęcia przez host.
- Checkpoint należy do hosta. Adapter dostaje tylko swój kursor/epokę i uchwyt przyjęcia, nigdy
  `InboundStateStore`, granty ani ścieżkę na dysku.
- Zdarzenie jest przyjęte trwale przed przesunięciem kursora; awaria między tymi krokami kończy
  się deduplikowanym replay. Brak wyniku nie oznacza sukcesu; żaden timeout nie potwierdza danych.
- Zdarzenia ignorowane, niewspierane i bez efektu przesuwają checkpoint (Telegram może przesunąć
  offset bez sztucznej wiadomości użytkownika). Obsłużone są reset epoki, błędne i
  nieuporządkowane batche, częściowe potwierdzenia i limit kolejki.
- SDK nie przyjmuje surowych update'ów platformy: normalizacja jest w pakiecie, host przyjmuje
  zdarzenia semantyczne.
- Slack i Discord mają udokumentowane granice ACK/reconnect (`2026-11-04-slack-chat.md`,
  `2026-11-04-discord-chat.md`); nie ma gwarancji exactly-once ani trwałego replay z platformy.

### Poświadczenia i rotacja Slacka

- `ChatBotServices.credentials.accessToken(slot, operation)` zwraca aktualny access token
  związanego profilu poświadczeń. Uchwyt nie pozwala wskazać innego projektu ani klucza vault.
- Refresh token i client secret nie trafiają do adaptera. Rotacja zachowuje lock między
  procesami, zapis `pending` przed użyciem jednorazowego tokenu, zapis `ready` po odpowiedzi i
  odmowę przy niepewnym wyniku (`2026-11-05-slack-token-rotation.md`).
- Profil wymiany jest zamknięty i hostowy (`slack-oauth-v1`), dostępny przez publiczny interfejs
  dla każdej wtyczki, której użytkownik go zatwierdził — bez warunku na konkretny `extensionId`.
  Miejsce docelowe, pola, redakcja i limity odpowiedzi są stałe; nie ma ogólnego proxy HTTP z
  dostępem do vault.
- **Dlaczego nie zwykłe `secrets.get/set`:** zmieniłoby to ekspozycję sekretów i zgubiło ochronę
  jednorazowych refresh tokenów.

### Natywne komendy Discorda i prezentacja

- `ChatInteractionContext.taskChoices(query)` to wąska usługa opcji zadań dla aktywnej interakcji;
  core autoryzuje osobę, czat i projekt. Kontekst jest krótkotrwały, związany z konkretnym
  zdarzeniem i nie może zmienić aktora/projektu, ominąć grantów ani uruchomić pracy. Limity liczby
  wyników, długości, czasu i częstotliwości obowiązują na hoście. Nie zastępuje go szerokie
  `tasks.list()` ani `project.read` dla adapterów.
- Discord pilnuje deadline ACK/defer i życia tokenu interakcji; wykonanie komendy wraca jako
  zdarzenie do core, z tymi samymi potwierdzeniami.
- Metadane setupu, linki parowania, prefiksy komend, limity przycisków i tekstu oraz formatowanie
  wiadomości są deklaratywne (manifest `chatProviders`, deskryptor hosta). Renderowanie działa po
  stronie hosta/adaptera na ograniczonych danych zatwierdzonych przez core; żaden kod wtyczki nie
  trafia do Reacta.

### Zgodność

- Nowe możliwości są opcjonalne wewnątrz API `0.1`. Brak wymaganej możliwości daje czytelną
  odmowę aktywacji, nie cichy fallback do słabszej semantyki.
- Manifest jest parsowany strictly: starszy host może odrzucić manifest z nowym polem
  (BACKWARD_COMPATIBILITY.md §6b).
- SDK jest Node-free; adaptery używają Node i deklarują własne zależności. HTTP jest w
  `packages/contract`, IPC w `packages/cezar/src/extensions/protocol.ts`.
- Każda operacja (receive, sekrety, ACK/defer, komendy natywne, send) dziedziczy
  `ExtensionChatOperationContext`: kontrolę ważności przed efektem, abort, generację, timeout,
  limity i redakcję.
- Klienci HTTP adapterów zachowują stałe hosty, walidację DNS/adresów, politykę przekierowań,
  limity odpowiedzi, proxy i własne CA (`shared/pinned-request.ts`).

## 5. Instalacja, zaufanie i tryby działania

Jeden resolver artefaktów i jeden zwykły worker host. Katalog dostawy Cezara
(`dist/chat-plugins/catalog.json`, budowany przez `packages/cezar/scripts/build-chat-delivery.mjs`)
mapuje provider `telegram`/`slack`/`discord` na konkretny manifest, wersję i digest; host
weryfikuje integralność przed aktywacją. Tylko ten katalog przyznaje historyczny alias providera:
nazwa paczki nie daje prawa do aliasu ani do sekretów istniejącego bota.

- Lokalnie skonfigurowany bot używa zweryfikowanego artefaktu dostarczonego z Cezarem, bez
  pobierania z npm. Instalacja zewnętrzna przechodzi standardowy podgląd i zgodę.
- Zgoda na wbudowaną integrację nie upoważnia do uruchomienia dowolnej paczki o tej samej nazwie.
  Zmiana źródła/digestu/uprawnień wymaga przeglądu i potwierdzenia wyboru implementacji
  (`/extensions/chat-selections/:provider/{preview,select}`).
- Jawnie wybrana zainstalowana wersja pozostaje przypięta; aktualizacja Cezara jej nie
  nadpisuje. Domyślny artefakt jest przypięty do wydania Cezara.
- Disable nie uruchamia fallbacku omijającego decyzję użytkownika. Brakująca lub wyłączona
  wybrana wersja zainstalowana zostawia integrację wyłączoną do jawnego wyboru źródła; nie
  aktywuje w tle wersji dostarczonej. Dialog oferuje jawną akcję „Return to version shipped with
  Cezar”, zachowującą sparowania. Disconnect/reset to odrębne operacje.
- `CEZ_EXTENSIONS=0`: zainstalowane rozszerzenia nie działają, a zweryfikowany artefakt
  dostarczony z Cezarem działa przez zaufany facade in-process (`trusted-chat-worker.ts`) — ta sama
  implementacja pakietu i te same publiczne usługi. Wybrana wersja zainstalowana nie ma wtedy
  fallbacku. Powiadomienia nadal wymagają `CEZ_WEBHOOKS=1`, sterowanie zadaniami także
  `CEZ_CHAT_INBOUND=1`; brak flag nie uruchamia ruchu.
- Hosted nie udostępnia czatu bez `CEZ_REMOTE_EXTENSIONS=1` (`2026-11-12-hosted-extensions.md`).
  Dry-run dostaje zablokowany transport.
- Przy zmianie właściciela stary jest zatrzymywany i kończony przed startem następnego; restart i
  fallback mają limity czasu. Start działa przy readonly home, brakujących/uszkodzonych
  artefaktach i z redakcją niekompletnej diagnostyki.

### Nawigacja i zakres ustawień

| Miejsce | Zakres | Zawartość i działania |
| --- | --- | --- |
| Settings → Extensions | Globalny katalog zainstalowanych i dostarczonych pakietów; zgoda zawsze dla wskazanego projektu | Źródło, wersja, uprawnienia, zgodność, aktualizacja, włączenie/wyłączenie dla projektu, odinstalowanie. Telegram, Slack, Discord i zainstalowany Mattermost są zwykłymi pozycjami. |
| Project settings → Integrations | Konkretny projekt w nagłówku i URL | Galeria z kategoriami: komunikatory, trackery, testy, ogólne webhooki. Szczegół usługi: setup, stan, odbiorcy, historia, parowanie, zgody i rozłączenie. |

**Dlaczego tak:** osobna zakładka ustawień na każdą kategorię rozdrabniałaby nawigację, a ten sam
formularz w dwóch ekranach tworzyłby konkurujące miejsca konfiguracji.

- Przełączniki `All`, `Chat`, `Issue tracking`, `Testing`, `Webhooks` filtrują galerię razem z
  wyszukiwarką. `Chat` obejmuje Telegram, Slack, Discord i providery z rozszerzeń (np.
  Mattermost), także warianty samych powiadomień; `Webhooks` to ogólne endpointy. `Testing`
  zawiera `TesterArmyE2eCard`. Niedostępność nie ukrywa zapisanej integracji wymagającej naprawy.
  Nowa wtyczka nie tworzy zakładki w menu ustawień.
- Filtr kategorii nie jest tożsamością integracji. Bezpośredni link otwiera szczegół niezależnie
  od filtra; powrót do galerii odtwarza filtr, wyszukiwanie i fokus. Zmiana kategorii niczego nie
  instaluje, nie włącza i nie zapisuje.
- Pakiety dostarczone mają oznaczenie „Shipped with Cezar”; pochodzenie zewnętrznej wersji jest
  widoczne.
- Szczegół wtyczki w Extensions linkuje „Manage <provider> connection” do formularza Integrations
  wskazanego projektu; Integrations linkuje „Manage extension” z powrotem. Parametry
  `extension=<extensionId>` i `project=<projectId>` wybierają tylko widok; każda operacja podlega
  walidacji hosta. Sekrety nigdy nie trafiają do URL.
- Stan pakietu, zgoda na jego użycie w projekcie, stan połączenia i uprawnienia osoby/czatu są
  rozdzielone: `Installed` nie znaczy `Connected` ani zgody na zadania. Jeden widok providera
  zawiera jego boty i odbiorców, niezależnie od źródła artefaktu.
- Połączenia pozostają widoczne po disable, uninstall, awarii lub braku pakietu, z przyczyną i
  działaniem naprawczym, bez startowania workera tylko dla wyświetlenia ekranu.
- `Disable extension`, `Disconnect` i cofnięcie zgody osoby/czatu są różnymi operacjami.
  Usunięcie/aktualizacja pokazuje dotknięte projekty i skutek. Otwarcie katalogu nie instaluje,
  nie włącza i nie odpytuje rejestru npm.
- Zmiana projektu czyści draft i kontekst formularza; refetch metadanych tego samego projektu nie
  resetuje aktywnego parowania.
- Panele, formularze i komendy innych rozszerzeń zachowują swoje miejsca wpięcia.

### Adresy

`/settings/global/extensions` oraz `/p/:projectId/settings/integrations?integration=<providerId>`
(`integration=e2e` otwiera TesterArmy). Wydane adresy `settings/webhooks`, `settings/tracker` i
nieskopowane `/settings/...` przechodzą przez resolver starych tras bez pętli i utraty parametrów
(`endpoint`, `tab`, query/hash, jawny projekt, linki do historii usuniętego odbiorcy). Jawnie
wskazany, nieistniejący projekt daje stan niedostępności, nigdy fallback do innego projektu.

### Mattermost

Przykład niezależnego pakietu publicznego SDK (`examples/extensions/mattermost`). Instaluje się go w
Extensions, a bota, kanały, sparowania i zgody konfiguruje tym samym flow Integrations co inne
komunikatory. Wysyła wiadomości, odpytuje kanały przez sesję `ordered` (jedna strona na
checkpoint), przekazuje komendy i tekstowe potwierdzenia do core, z trwałym kursorem,
chronologiczną obsługą, anulowaniem i udokumentowanymi ograniczeniami pollingu. Nie deklaruje
paneli ani komend z `location`.

### Wersjonowanie i dostawa

Pakiety adapterów mają własne wersje semver; wersja manifestu jest identyczna z `package.json`.
Są publikowane w zestawie wydania po SDK (`scripts/release.mts`, `docs/publishing.md`); wydanie
hosta nie podbija ich wersji i nie nadpisuje opublikowanego artefaktu. Bundle Cezara wskazuje
dokładne przetestowane wersje i digesty: `scripts/build-chat-plugins.mjs` buduje pakiety, a build
hosta stempluje je do `dist/chat-plugins` z zależnościami, bez przepisywania kodu pod prywatne API.
Digest liczony jest po wszystkich krokach builda. Instalacja offline nie wymaga hoistowanych
zależności hosta.

## 6. Stan na dysku

Tożsamości, których zmiana źródła artefaktu nie przeklucza:

| Zasób | Tożsamość / ścieżka |
| --- | --- |
| Stan bota | `.ai/cezar/webhooks/chat/<provider>/<bot>.json`; dry-run osobno; boty nienumeryczne mają kodowaną nazwę pliku |
| Własność między procesami | `~/.cezar/chat/<provider>/bots/<botId>/{owner.lock,binding.json}` przez `cezarHomeDir()` |
| Odbiorcy | `.ai/cezar/webhooks/endpoints.json`, receiver ID, format `.v1`, rewizja i test dostarczenia |
| Sekrety | Vault projektu, audience `cezar`, referencje `WEBHOOK_CHAT_*`; nigdy w ustawieniach wtyczki |
| Rotacja Slacka | `SLACK_ROTATION_*` w vault oraz `~/.cezar/slack-token-locks/`, stan `pending`/`ready` |
| Wybór implementacji | `.ai/cezar/extensions/chat-selections/<provider>.json`; artifact leases w `~/.cezar/extensions/leases/` |
| Historia zadań | `chatSource`, konteksty rozmów i korelacje używają identyfikatorów providerów |

Odbiorcy Slack/Discord używający tylko webhooka (wydani w v0.17.0) pozostają takimi odbiorcami.
Instalacja paczki nie zamienia ich w boty; upgrade do bota wymaga testu dostarczenia i zachowuje
receiver ID.

Zmiana implementacji bota: pod bieżącym lease odczyt stanu i sprawdzenie zgodności artefaktu oraz
możliwości SDK; wstrzymanie nowych operacji, anulowanie oczekujących, zatrzymanie odbioru i
utrwalenie dziennika (nigdy dwóch odbiorców równolegle); start nowego właściciela z tym samym
kluczem lease i wznowienie od hostowego checkpointu. Nieudana aktywacja kończy nowego właściciela;
potwierdzone wiadomości nie wykonują się ponownie.

Rollback artefaktu nie cofa świata zewnętrznego: nie przywraca zużytego refresh tokenu,
checkpointów ani wykonanych zadań. Starszy kod pakietu musi obsłużyć bieżący stan albo
integracja zatrzymuje się z instrukcją naprawy.

## 7. Testy i dowód niezależności

1. **Statycznie:** pakiety nie importują prywatnego Cezara, kontraktu, api-client ani ścieżek
   poza pakiet; publikowany tarball nie ma zależności workspace/file.
2. **Poza repo:** `pack-smoke.mjs` każdego pakietu pakuje SDK i adapter, instaluje je w czystym
   consumerze i uruchamia prawdziwy worker; `npm run test:package` sprawdza spakowany Cezar z
   adapterami na lokalnych symulatorach platform.
3. **Zgodność:** wspólny zestaw `chat/test-support/conformance.testkit.ts` przez rzeczywisty
   adapter; `npm run test:chat-plugins` buduje i testuje każdy pakiet (`node:test`).
4. **Awaria i stan:** kill przed/po accept/checkpoint, częściowy batch, brak/spóźniony ACK,
   timeout IPC, zablokowany worker, częściowy sekret w stderr, disable/revoke w trakcie I/O,
   concurrent install/update/uninstall, artifact leases, readonly/corrupt home, rotacja tokenu.
5. **Autoryzacja:** obca osoba/czat/projekt, kopiowany callback, reuse/expiry, brak uprawnień.
   Dane z platformy są niezaufane.
6. **UI/e2e:** symulowane suity przeglądarkowe `packages/web/e2e/{telegram,slack,discord}-*`,
   `extensions` i `integrations-section` (instalacja, setup, restart, polecenie, odmowa,
   aktualizacja, wybór implementacji, wyłączenie, odinstalowanie, nawigacja między Extensions i
   Integrations, stare linki). Uruchamiane ręcznie przez `npm run test:e2e:runner` przed wydaniem,
   nie w CI.

Testy mają izolowany `CEZ_HOME`, syntetyczne sekrety, limit czasu i blokadę zewnętrznej sieci.

## 8. Ryzyka i ograniczenia

Główne ryzyka: rozbudowa SDK pod szczegóły jednej platformy, ujawnienie refresh sekretów, utrata
update'u przy zmianie kursora, zmiana przestrzeni dedupe/lease, deadline Discorda, niejawna
aktywacja po disable, rollback cofający zużyty sekret; w UI pomylenie globalnej instalacji z
połączeniem projektu i ukrycie połączenia wymagającego naprawy. Ogranicza je wspólny kontrakt i
testy powyżej.

Zasada: zmiana, która wymaga prywatnego importu, osłabienia grantu, przesunięcia checkpointu
przed accept, oddania refresh tokenu workerowi lub wyłączenia działającego scenariusza
`CEZ_EXTENSIONS=0`, jest sygnałem do korekty kontraktu, nie wyjątkiem dla „oficjalnej” wtyczki.
