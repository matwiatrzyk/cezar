# Plan: niezależne wtyczki Telegram, Slack i Discord

Status: zrealizowane; to działająca architektura (`packages/chat-plugins/`,
`extensions/delivery-catalog.ts`). §2 opisuje punkt wyjścia `875b5243b`.
Aktualizacja 2026-11-09: Extensions zarządza pakietami; Integrations pozostaje
jednym ekranem konfiguracji projektu z przełączanymi kategoriami.

## 1. Cel i granice

Telegram, Slack i Discord mają być trzema samodzielnymi pakietami rozszerzeń,
działającymi przez publiczne SDK. Ten sam artefakt można instalować z folderu/paczki
oraz dostarczać razem z Cezarem. Wyjęcie paczki z repozytorium nie może odbierać jej
funkcji ani wymagać importowania prywatnych modułów hosta.

Zachowujemy decyzje użytkownika: fork rozwijany długoterminowo, flagi środowiskowe,
eksperymentalne SDK `apiVersion: 0.1` zmieniane addytywnie oraz miejsca wpięcia V1.1.
Istniejące boty, sparowania, uprawnienia i odbiorcy mają działać bez ponownego setupu.
Nowy start Cezara nie może pobierać pakietów z rejestru.

Ustawienia rozdzielają zarządzanie oprogramowaniem od konfiguracji projektu:
globalne **Extensions** zarządza wtyczkami, a projektowe **Integrations** zachowuje
konfigurację usług z przełączanymi kategoriami. Nie dodajemy zakładek Connections
ani Testing; testy przeglądarkowe pozostają kategorią Integrations.
Ten podział nie wymaga wydzielenia Jira, Linear ani webhooków do wtyczek
i nie zmienia ich obecnego działania.

Zakres nie obejmuje marketplace, podpisów paczek, sandboxa, publikacji npm, pusha,
zmian produkcyjnych sekretów ani naprawy wszystkich ograniczeń dostarczania zdarzeń
platform. Publikacja i próby na prawdziwych kontach są osobnymi czynnościami.
Sam proces Node nie jest granicą bezpieczeństwa wobec złośliwej wtyczki.

## 2. Stan obecny i warunek zakończenia

Obecnie `packages/cezar/bundled-chat/*/index.ts` importuje prywatne transporty
z `src/chat/providers/` i `runBundledWorker`. Własny katalog, protokół bundled i
`BundledChatOwner` współistnieją ze zwykłym `ExtensionManager`/`ExtensionHost`.
Publiczny przykład komunikatora to `examples/extensions/mattermost`.

Warunek zakończenia to wszystkie poniższe punkty, a nie samo uruchomienie workera:

1. Trzy pakiety z manifestem rozszerzenia, buildem, własnymi zależnościami,
   testami i README; brak importów prywatnego Cezara/kontraktu i ścieżek do monorepo.
2. Pakiet zainstalowany poza repozytorium komunikuje się z Cezarem wyłącznie przez
   publiczny kontrakt. Wersja bundled używa tego samego wejścia i API.
3. Wbudowane dostarczanie jest decyzją hosta o pochodzeniu i zaufaniu do artefaktu,
   nie osobną implementacją transportu ani dodatkowym prywatnym API.
4. Stare identyfikatory, stan, bot leases, zgody, HTTP i ścieżki UI zachowują znaczenie.
   Dla jednego bota istnieje dokładnie jeden aktywny odbiorca.
5. Wszystkie dotychczasowe scenariusze funkcjonalne mają testy na nowej ścieżce.
   Istnieją dowody instalacji, aktualizacji i restartu z rzeczywistej paczki poza repo.
6. Usunięto stary protokół bundled i podwójne implementacje adapterów po przejściu
   bramek zgodności. Wyjątek dla trybu kompatybilności opisano w §5.
7. Wtyczka ma jedno miejsce zarządzania w Extensions, a połączenie jeden formularz
   w Integrations. Kategorie i odnośniki prowadzą do właściwego projektu i szczegółu;
   Mattermost podlega tym samym regułom, a kategoria Testing zachowuje setup testów.

## 3. Docelowy podział odpowiedzialności

| Obszar | Wtyczka | Host Cezara |
| --- | --- | --- |
| Protokół platformy | HTTP, WebSocket, polling, reconnect, parsery, ACK platformowy | Limity i kontrola życia adaptera |
| Zdarzenia | Normalizacja do publicznego formatu, stabilne ID, kolejność | Trwałe przyjęcie, deduplikacja, dziennik i checkpoint |
| Zadania | Przekazuje intencję/zdarzenie; renderuje wynik | Parowanie, zgody osoby/czatu, Confirm, wybór projektu, wykonanie |
| Poświadczenia | Tylko uprawniony dostęp dla konkretnego bota/operacji | Vault, zakres sekretów, trwała rotacja, koordynacja między procesami |
| Życie procesu | Dispose, przerwanie I/O, zgłoszenie health | Restart/backoff, timeouty, fencing, jeden właściciel bota, artefakt leases |
| UI i instalacja | Deklaratywne metadane setupu/prezentacji | Extensions dla pakietów, Integrations z kategoriami dla konfiguracji projektu, zgodne stare trasy |

Pakiety umieszczamy w `packages/chat-plugins/{telegram,slack,discord}` jako osobno
budowalne projekty. README zawierają przykład instalacji z folderu i tarballa.
Nie dodajemy drugiej kopii źródeł w `examples/`; stamtąd prowadzą odnośniki.
Nazwy pakietów npm i docelowy scope ustala się przed publikacją; plan nie zakłada
prawa do publikowania w `@open-mercato`. Logiczna tożsamość wtyczki musi być stała
przed pierwszym zapisem stanu i niezależna od miejsca instalacji artefaktu.

Współdzielony kod transportowy wolno wydzielić dopiero przy rzeczywistym użyciu
przez dwa adaptery. Musi wtedy być samodzielną zależnością publiczną/bundlowaną;
prywatny import do `packages/cezar` nie jest sposobem współdzielenia.

## 4. Braki SDK i decyzje kontraktowe przed ekstrakcją

Schematy, sygnatury, limity i przypadki odmowy tych usług są w
`packages/extension-sdk/src/` i w testach kontraktu.

### Odbiór i trwałość

- Jeden model odbioru: `receiveSession` dla wymaganego `receiveModel` (`ordered` albo
  `opaque`) — start, stop/abort, health oraz potwierdzenie trwałego przyjęcia przez host.
  Model V1 `receive(after)` usunięto przed pierwszą publikacją SDK; Mattermost przeszedł
  na sesję `ordered`.
- Checkpoint należy do hosta. Adapter dostaje tylko swój kursor/epokę i uchwyt
  przyjęcia, nigdy cały `InboundStateStore`, granty ani ścieżkę na dysku.
- Opisać atomowość: event przyjęty trwale przed przesunięciem kursora; awaria między
  tymi krokami prowadzi do deduplikowanego replay. Brak wyniku nie oznacza sukcesu.
- Ująć zdarzenia ignorowane, niewspierane i bez efektu. Telegram musi móc bezpiecznie
  przesunąć offset po takim update bez tworzenia sztucznej wiadomości użytkownika.
- Ująć reset epoki po długiej bezczynności Telegrama, błędne/nieuporządkowane batche,
  częściowe potwierdzenia i limit pamięci/kolejki. Żaden timeout nie potwierdza danych.
- Nie wystawiać `process(rawTelegramUpdate)` w SDK. Normalizacja platformowa trafia
  do pakietu; host przyjmuje semantyczne zdarzenia. Rozszerzyć format addytywnie tam,
  gdzie brakuje semantyki obecnego `InputUpdate` (wiele dotkniętych czatów, kwalifikacja
  parowania, polecenia kierowane do konkretnego bota, puste checkpointy).
- Slack/Discord zachowują jawnie udokumentowane granice ACK/reconnect. Ten refaktor
  nie dostarcza automatycznie gwarancji exactly-once ani trwałego replay z platformy.

### Poświadczenia i rotacja Slacka

- Potrzebna jest usługa hostowego uzyskania aktualnego access tokenu dla związanego
  profilu poświadczeń. Publiczny uchwyt nie pozwala podać innego projektu ani klucza vault.
- Refresh token i client secret nadal nie trafiają do adaptera. Rotacja zachowuje
  lock między procesami, zapis `pending` przed możliwym zużyciem jednorazowego tokenu,
  zapis `ready` po odpowiedzi oraz odmowę przy niepewnym wyniku.
- Projekt usługi ma być używalny przez zewnętrzną wtyczkę, bez warunku
  `extensionId === officialSlack`. Wyjątkiem może być tylko jawna zgoda użytkownika
  i zakres deklarowanego profilu; nie ukryte uprawnienie dla pakietu bundled.
- Opis wymiany tokenu musi być deklaratywny i walidowany: dozwolone miejsce docelowe,
  pola wejścia/wyjścia, redakcja, ograniczenia odpowiedzi i brak przekierowania sekretu
  na dowolny URL. Nie tworzyć ogólnego proxy HTTP z uprawnieniami vault.
- Pierwsza implementacja może obsługiwać zamknięty, hostowy profil wymiany używany
  przez Slacka, dostępny przez publiczny interfejs dla każdej uprawnionej wtyczki.
  Nie projektujemy uniwersalnego silnika OAuth. Niezależność pakietu oznacza zależność
  od jawnie wersjonowanej usługi hosta, nie brak wszystkich usług platformowych w core.
- Nie przenosić rotacji do zwykłego `secrets.get/set`: zmieniłoby to ekspozycję
  sekretów i zgubiło ochronę jednorazowych refresh tokenów. Ograniczony profil
  `slack-oauth-v1` odtwarza obecne przypadki Slacka.

### Natywne komendy Discorda i prezentacja

- Dodać wąską usługę odczytu opcji zadań dla aktywnej interakcji, z autoryzacją
  osoby, czatu i projektu w core. Nie zastępować jej szerokim `tasks.list()` ani
  nadaniem `project.read` wszystkim adapterom tylko dla autocomplete.
- Host wiąże kontekst z konkretną sesją/zdarzeniem; adapter nie może sam nadać mu
  uprawnień. Limit liczby wyników, długości, czasu i częstotliwości obowiązuje na hoście.
- Discord nadal pilnuje deadline ACK/defer i życia tokenu interakcji. Wykonanie
  komendy wraca jako zdarzenie do core, z dotychczasowymi potwierdzeniami.
- Zmapować metadane setupu, linki parowania, prefiksy komend, rozpoznawanie grup,
  limity przycisków i tekstu oraz formatowanie wiadomości. SDK nie może wymusić
  uniwersalnego tekstu kosztem obecnych zachowań providerów.
- Jeżeli potrzebny jest renderer, działa po stronie adaptera na ograniczonych danych
  już zatwierdzonych przez core. Żaden kod wtyczki nie jest wstrzykiwany do Reacta.

### Zgodność i wymagania wersji

- Nowe możliwości są opcjonalne wewnątrz API `0.1`; stare manifesty i adaptery nadal
  działają. Brak wymaganej możliwości daje czytelną odmowę aktywacji, nie cichy fallback
  do słabszej semantyki. Dodać jawne wymagania funkcji hosta i wersji w kontrakcie.
- Nowe pola manifestu podlegają obecnej regule strict-parse: starszy host może odrzucić
  taki manifest. Opisać minimum hosta, downgrade i odzyskanie zgodnej wersji pakietu.
- SDK zostaje Node-free; adaptery mogą używać Node i deklarują własne zależności.
  HTTP pozostaje w `packages/contract`, IPC wewnętrzne w Cezarze.
- Każda nowa operacja dziedziczy `ExtensionChatOperationContext`: kontrola ważności
  przed efektem, abort, generation, timeout, bounds i redakcja. Dotyczy to też receive,
  sekretów, ACK/defer oraz komend natywnych, nie tylko `send`.
- Zachować zabezpieczenia klientów HTTP (stałe hosty, walidacja DNS/adresów,
  redirect policy, limity odpowiedzi), proxy i własne CA. Prywatny helper sieciowy
  należy wydzielić do publicznej zależności albo przenieść z testami; zamiana na
  nieograniczony `fetch` nie jest parzystością funkcjonalną.

## 5. Instalacja, zaufanie i tryby działania

Jedno źródło resolvera artefaktów i jeden zwykły worker host. Katalog dostawy Cezara
mapuje historyczny alias na konkretny manifest/entry/digest zwykłej wtyczki. Tożsamość
platformowa i katalog dostawy pozostają metadanymi hosta; nazwa paczki nie daje prawa
do przejęcia aliasu `telegram`, `slack`, `discord` ani sekretów istniejącego bota.

- Lokalnie: skonfigurowany bot używa dostarczonego i sprawdzonego artefaktu, bez
  pobierania z npm. Nowa instalacja zewnętrzna przechodzi standardowy preview i zgodę.
- Istniejąca zgoda na wbudowaną integrację nie upoważnia do uruchomienia dowolnej
  paczki o tej samej nazwie. Podmiana źródła/digestu/praw wymaga właściwej polityki
  aktualizacji i zgody; przejęcie legacy aliasu odbywa się tylko przez hostową mapę.
- Jawnie wybrana przez użytkownika zgodna wersja pozostaje przypięta; aktualizacja
  Cezara nie nadpisuje jej po cichu. Domyślny bundle jest przypięty do wydania Cezara.
- Disable nie może uruchomić fallbacku omijającego decyzję użytkownika. Uninstall
  ręcznie wskazanego zastępstwa pozostawia integrację wyłączoną do jawnego wyboru
  źródła; nie aktywuje w tle starego bota.
- Dialog może oferować osobną, jawną akcję „Usuń zastępstwo i wróć do wersji
  dostarczonej z Cezarem”, zachowując sparowania. Disconnect/reset pozostają
  odrębnymi operacjami. Wyłączenie musi być respektowane również przez obsługiwany
  starszy host; sam nowy rekord wyboru implementacji nie wystarczy, jeśli jest ignorowany.
- `CEZ_EXTENSIONS=0`, dry-run i hosted zachowują dotychczasową macierz zachowań,
  bez uruchamiania nowych workerów. W okresie przejścia służy do tego stara ścieżka.
- Konkretnie: hosted nie udostępnia chatu; lokalnie extensions-off pozostawia
  istniejący compatibility path, ale powiadomienia nadal wymagają `CEZ_WEBHOOKS`,
  a sterowanie zadaniami także `CEZ_CHAT_INBOUND`. Brak flag nie uruchamia ruchu.
- Przed usunięciem starej ścieżki zaufana wersja dostarczona z Cezarem musi umieć
  działać przez zgodny facade SDK w procesie hosta, jeśli tego wymaga obecny tryb.
  Facade używa tej samej implementacji pakietu i publicznych usług; nie uruchamia
  w procesie hosta dowolnych zainstalowanych rozszerzeń. Brak takiego dowodu blokuje
  usunięcie starej ścieżki. Nie zmieniamy znaczenia flag pod pozorem refaktoru.
- Awaria: abort/retire i zakończenie właściciela przed uruchomieniem następnego;
  restart i fallback mają ograniczenia czasowe. Zachować start przy readonly home,
  brakujące/uszkodzone artefakty i redakcję niekompletnej diagnostyki.

### Nawigacja i zakres ustawień

Wybrany podział zachowuje jeden ekran Integrations dla konfiguracji projektu.
Extensions odpowiada za zainstalowane oprogramowanie. Oddzielne zakładki ustawień
dla każdej kategorii wtyczek rozdrabniałyby nawigację, a powielenie formularzy
w obu ekranach tworzyłoby konkurujące miejsca konfiguracji. Kategorie są filtrem
wewnątrz Integrations; oba ekrany łączą się odnośnikami do jednego formularza.

| Miejsce | Zakres | Zawartość i działania |
| --- | --- | --- |
| Settings → Extensions | Globalny katalog zainstalowanych/dostarczonych pakietów; zgoda na użycie zawsze dla wskazanego projektu | Źródło, wersja, uprawnienia, zgodność, aktualizacja, włączenie/wyłączenie dla projektu i odinstalowanie. Telegram, Slack, Discord oraz zainstalowany Mattermost są zwykłymi pozycjami katalogu. |
| Project settings → Integrations | Konkretny projekt widoczny w nagłówku i URL | Jedna galeria z kategoriami: komunikatory, trackery, testy, ogólne webhooki. Po wyborze usługi jej setup, stan i działania, w tym odbiorcy, historia, parowanie, zgody i rozłączenie. |

- Etykiety głównych ekranów pozostają `Extensions` i `Integrations`. W Integrations
  przełączniki `All`, `Chat`, `Issue tracking`, `Testing`, `Webhooks` filtrują
  istniejącą galerię, razem z jej wyszukiwarką. `Chat` obejmuje Telegram, Slack,
  Discord i Mattermost, również warianty samych powiadomień; `Webhooks` oznacza
  ogólne endpointy, bez drugiej kopii kafelków Slacka/Discorda. `Testing` zawiera
  obecny `TesterArmyE2eCard`, z wykrywaniem konfiguracji i śledzeniem setup run.
  Pokazywać kategorie mające widoczne pozycje; niedostępność nie usuwa zapisanej
  integracji wymagającej naprawy. Nowa wtyczka nie tworzy zakładki w menu ustawień.
- Filtr kategorii nie jest tożsamością integracji. Wejście z wyszukiwarki lub
  bezpośredniego linku otwiera jej szczegół niezależnie od poprzedniego filtra;
  powrót do galerii odtwarza filtr, wyszukiwanie i fokus. Zmiana kategorii niczego
  nie instaluje, nie włącza ani nie zapisuje w konfiguracji usługi.
- Dostarczone pakiety mają oznaczenie `Bundled with Cezar`
  („Dostarczane z Cezarem”); pochodzenie
  zewnętrznego zastępstwa jest widoczne. Nie nazywać ich niezależnymi, dopóki ich
  ekstrakcja nie przejdzie bramek. Grupowanie komunikatorów można wywieść z
  `chatProviders`; nie wymaga to nowej taksonomii manifestu ani marketplace.
- Szczegół wtyczki oferuje `Configure connection` dla jawnie wskazanego projektu.
  Bez projektu najpierw wybór projektu; nie zapisywać do przypadkowego `default`.
  Link otwiera kanoniczny formularz Integrations. Powrotny `Manage extension`
  zachowuje tożsamość wtyczki i projektu, bez sekretów w URL.
- Rozdzielić stan pakietu, zgodę na jego użycie w projekcie, stan połączenia oraz
  uprawnienia osoby/czatu. `Installed` nie znaczy `Connected` ani zgody na zadania.
  W Integrations jeden widok providera zawiera jego boty/odbiorców; nie tworzyć
  osobnych kopii tego widoku dla bundled, zewnętrznego pakietu i webhook-only.
  Jeden provider może nadal mieć wielu odbiorców zgodnie z obecnym modelem.
- Istniejące połączenia pozostają rozpoznawalne po disable, uninstall, awarii lub
  braku pakietu. Pokazać przyczynę i dostępne działanie naprawcze, bez startowania
  workera tylko dla wyświetlenia ekranu. Odczyt i unieważnienie hostowych zgód
  działają wyłącznie w granicach istniejących capability/API; UI nie omija flag.
  Przy extensions-off Integrations nadal obsługuje dozwoloną ścieżkę kompatybilności.
  Hosted zachowuje brak chatu, a dostępność trackerów/testów pozostaje niezależna.
- `Disable extension`, `Disconnect` i cofnięcie zgody osoby/czatu są różnymi
  operacjami. Przed globalnym usunięciem/aktualizacją wskazać dotknięte projekty
  i skutek; zachować politykę zgód i wycofania opisaną powyżej. Otwarcie katalogu
  nie instaluje, nie włącza i nie sprawdza rejestru npm automatycznie.
- Zmiana projektu czyści draft i kontekst formularza; zwykły refetch metadanych
  tego samego projektu nie resetuje aktywnego parowania. Używać istniejących
  komponentów setupu, hostowego vault i kontraktów; nie kopiować poświadczeń
  do ogólnego formularza ustawień wtyczki.
- Panele, formularze i komendy innych rozszerzeń zachowują miejsca V1/V1.1.
  Integrations dotyczy konfiguracji usług projektu, nie zastępuje dowolnych ustawień
  rozszerzenia ani task view, sidebara czy palety komend.

### Stare adresy i Mattermost

Zachować adresy `/settings/global/extensions` oraz
`/p/:projectId/settings/integrations` z parametrem `integration=<providerId>`
do wyboru providera. `integration=e2e` nadal otwiera TesterArmy w Integrations.
Nie dodawać tras `/settings/connections` ani `/settings/testing`: wcześniejsza
propozycja istniała tylko w planie i nie wymaga aliasów kompatybilności.
Szczegół Extensions może używać parametrów `extension=<extensionId>` i
`project=<projectId>`; są tylko wyborem widoku, każda operacja nadal podlega
walidacji projektu i uprawnień przez hosta.

Zachować query/hash, `endpoint`, `tab` i jawny projekt, w tym linki do historii
usuniętego odbiorcy. Dotychczasowe `settings/webhooks`, `settings/tracker`
i nieskopowane `/settings/...` przechodzą
przez zgodny resolver starych tras bez pętli i utraty parametrów. Jawnie wskazany,
nieistniejący projekt daje stan niedostępności, nigdy fallback do innego projektu.
Nie przemianowywać HTTP `/api/v1/...`, provider IDs ani zapisów na dysku z powodu
porządkowania galerii. Nowe linki, wyszukiwarka ustawień, komunikaty i dokumentacja
prowadzą do tego samego szczegółu Integrations, bez równoległego edytora w Extensions.

Mattermost pozostaje przykładem niezależnego pakietu publicznego SDK. Instaluje się
go w Extensions, a bot/token, kanały, sparowania i zgody konfiguruje przez ten sam
flow Integrations co inne komunikatory. Przykład wysyła wiadomości, odpytuje kanały
i przekazuje komendy/tekstowe potwierdzenia do core; zachowuje obecny trwały kursor,
chronologiczną obsługę, anulowanie i udokumentowane ograniczenia pollingu.
Nie deklaruje paneli ani komend z `location`, więc ta zmiana nie dodaje mu miejsca
w sidebarze, palecie ani widoku zadania. Odbiera przez sesję `ordered` (jedna strona
na checkpoint).

### Wersjonowanie i dostawa

Pakiety adapterów mają własne wersje semver, a wersja manifestu rozszerzenia jest
identyczna z `package.json`. Bundle Cezara wskazuje dokładne przetestowane wersje
i digesty. Nie należy bezrefleksyjnie dopisywać ich do obecnego zestawu paczek
automatycznie otrzymujących jeden numer wersji: `scripts/release*.{mts,mjs}` oraz
`src/release/manifests.ts` wymagają jawnej zmiany tej polityki.

W budowaniu bundle wykorzystujemy dokładnie artefakt niezależnego pakietu; dopuszczalne
jest rozpakowanie z zależnościami do katalogu dystrybucji, ale bez przepisywania kodu
pod prywatne API. Digest obliczamy po wszystkich krokach builda. Instalacja offline
nie może wymagać hoistowanych zależności hosta. Release/snapshot ma testowany graf
zależności: SDK → pakiety → pinowany katalog Cezara. Rzeczywista publikacja pozostaje
poza planowanym wdrożeniem lokalnym. Poprzedni zgodny artefakt i wersja dostarczona
z Cezarem pozostają dostępne lokalnie zgodnie z polityką leases/rollback.

## 6. Przeniesienie istniejących instalacji i wycofanie

Preferowana ścieżka to zgodny resolver/aliasy przy niezmienionych rekordach na dysku.
Nie zaczynamy od masowej zmiany nazw providerów ani od kopiowania grantów.
Bazą testu rollbacku jest `875b5243b`, czyli obecna działająca wersja forka z chatem;
nie dowolne starsze wydanie upstream sprzed tej funkcji. Obsługiwane późniejsze
baseline dopisuje się wraz z wydaniami. Aktywne, niedokończone sesje setup są dziś
w pamięci i po restarcie wygasają; zachowujemy ukończone sparowania, nie obiecujemy
utrzymania niedokończonego linku. Podobnie traktujemy efemeryczne potwierdzenia.

Najważniejsze istniejące miejsca zapisu, których nie wolno przekluczować przypadkiem:

| Zasób | Obecna tożsamość / ścieżka |
| --- | --- |
| Stan bota | `.ai/cezar/webhooks/chat/<provider>/<bot>.json`; wariant dry-run osobno; boty nienumeryczne mają kodowaną nazwę pliku |
| Własność między procesami | `~/.cezar/chat/<provider>/.../bots/<botId>/{owner.lock,binding.json}` przez `cezarHomeDir()` |
| Odbiorcy | `webhooks/endpoints.json`, receiver ID, format `.v1`, rewizja i test dostarczenia |
| Sekrety | Vault projektu, audience `cezar`, referencje `WEBHOOK_CHAT_*`; nie kopiować do settings wtyczki |
| Rotacja Slacka | `SLACK_ROTATION_*` w vault oraz `slack-token-locks/`, stan `pending/ready` |
| Historia zadań | `chatSource`, konteksty rozmów i korelacje używają historycznych provider IDs |

Odbiorcy Slack/Discord używający tylko webhooka pozostają takimi odbiorcami.
Instalacja paczki nie zamienia ich w boty; istniejący flow upgrade nadal wymaga
testu dostarczenia i zachowuje receiver ID. Zmieniające się pola bookkeeping
porównujemy semantycznie, nie wymagamy identyczności bajtowej całego pliku stanu.

Przed zmianą powstaje tabela każdego klucza/stanu: provider ID, `.v1` format,
receiver/bot ID, bot lease/binding generation, credential fingerprint, nazwa vault,
rotacja Slacka, journal epoch/offset, dedupe IDs, źródła rozmów, callbacki, pending
confirmations, setup IDs, HTTP/UI paths. Dla każdego: właściciel, reader/writer,
zachowanie po restarcie, starszym hoście i dwóch procesach.

Przełączenie bota:

1. Pod obecnym lease odczytać stan i sprawdzić zgodność artefaktu oraz możliwości SDK.
2. Wstrzymać przyjmowanie nowych operacji, anulować oczekujące, zatrzymać odbiór
   i utrwalić dziennik. Nigdy nie odpalać starego i nowego odbiorcy w trybie shadow.
3. Zachowując kanoniczny klucz lease i generację, uruchomić nowego właściciela;
   po zdrowej aktywacji wznowić odbiór od hostowego checkpointu.
4. Jeżeli aktywacja zawiedzie, zakończyć nowego właściciela i wznowić zgodną
   poprzednią implementację od trwałego stanu. Potwierdzone wiadomości nie mogą
   wykonać się ponownie, niepotwierdzone muszą być replayable tam, gdzie platforma
   dotąd dawała taką możliwość.

Jeżeli zmiana formatu okaże się konieczna: osobny projekt idempotentnej migracji
konfiguracji, pod lockiem, z atomowym zapisem, zachowaniem oryginału i testem
przerwania w każdej fazie. Nie migrować rekordów zadań. Nie obiecywać downgrade,
jeśli starszy host nie potrafi odczytać nowego stanu.

Rollback artefaktu nie oznacza cofnięcia świata zewnętrznego: nie przywracać zużytego
refresh tokenu, nie cofać trwałych checkpointów ani wykonanych zadań. Snapshoty
konfiguracji są oddzielone od dziennika i aktualnych sekretów. Pakiet o starym kodzie
musi obsługiwać aktualny stan albo integracja zatrzymuje się z instrukcją naprawy.

## 7. Testy i dowód niezależności

Macierz: trzy platformy × istniejąca/nowa konfiguracja × bundled/zewnętrzny tarball.
Dodatkowo V1 Mattermost, flags-off, hosted i dwa procesy dzielące CEZ_HOME.
Tryby niedostępne muszą być jawnie odrzucone bez startu procesu/nowego ruchu sieciowego.

1. **Statycznie:** lint/import-boundary zabrania prywatnego Cezara, contract, api-client,
   relatywnych wyjść z pakietu oraz workspace/file zależności w publikowanym tarballu.
   Analizować też deklaracje TS i zależności przechodnie.
2. **Poza repo:** `npm pack`, czysty consumer bez symlinków/workspace deps, instalacja
   zbudowanego Cezara i wtyczki; prawdziwy ExtensionHost/worker z rzeczywistym adapterem
   podłączonym do lokalnego symulatora. Sam scripted worker lub mock transportu nie wystarcza.
3. **Porównanie:** te same golden wejścia stary/nowy adapter, zgodne zdarzenia, przyciski,
   formaty, błędy i odpowiedzi. Gdy semantyka jest zmieniana, jawny wpis BC zamiast
   aktualizacji snapshotu bez uzasadnienia.
4. **Awaria:** kill przed/po accept/checkpoint, częściowy batch, brak ACK, spóźniony ACK,
   timeout IPC, zablokowany worker, descendant z otwartym pipe, partial-secret stderr,
   disable/revoke podczas przygotowania i już rozpoczętego I/O.
5. **Stan:** migracja wielokrotna, przerwana, concurrent install/update/uninstall, żywe
   artifact leases, readonly/corrupt home, zmiana tokenu, expiry i rotacja.
6. **Autoryzacja:** obca osoba/czat/projekt, kopiowany callback, reuse/expiry, brak
   uprawnień i rezygnacja z potwierdzenia. Dane z platformy pozostają niezaufane.
7. **UI/e2e:** instalacja, standardowy setup, ponowne otwarcie, restart, polecenie,
   odmowa, aktualizacja, rollback, wyłączenie i odinstalowanie; rzeczywiste etykiety
   providerów oraz brak resetowania sesji setup po aktualizacji listy. Dodatkowo:

   - Extensions → wybór projektu → Integrations → Manage extension zachowuje
     projekt i providera; dwa projekty nie współdzielą draftu ani poświadczeń.
   - Telegram/Slack/Discord/Mattermost używają jednego formularza połączenia;
     instalacja nie tworzy zgody chatu ani nie wysyła próbnej wiadomości.
   - Stare linki Integrations/webhooks/tracker i `integration=e2e` trafiają do
     właściwego ekranu; `endpoint`, `tab`, hash, historia usuniętego odbiorcy,
     nazwy ID wymagające kodowania oraz Back/Forward działają bez pętli.
   - Kategorie i wyszukiwanie wspólnie filtrują galerię; szczegół z linku działa
     mimo innej wcześniej wybranej kategorii. Powrót odtwarza filtr i fokus.
     Zainstalowanie kolejnej wtyczki nie dodaje głównej zakładki ustawień.
   - Disable/uninstall/awaria nie ukrywają istniejącego połączenia; zgodne stany
     flags-off i hosted nie wywołują niedozwolonych operacji. Powrót do bundled
     pozostaje jawną decyzją, a status Installed nie udaje Connected.
   - Jira/Linear zachowują poświadczenia i wybrany projekt/team; webhook-only
     zachowuje odbiorcę i historię; kategoria Testing zachowuje aktywny setup run bez
     ponownego uruchomienia. Nie powstają nowe automatyczne kontakty z platformami.
   - Nawigacja klawiaturą, fokus po otwarciu/powrocie i mobilne menu działają;
     nazwy dostępności i nagłówki używają nowych etykiet oraz nazwy projektu.

8. **Bramka repo:** typecheck, pełne testy, CLI, build/check:pack, test:package,
   SDK test/pack, jawne testy przykładów, kontrola dokumentacji i pełny e2e runner
   po świeżym buildzie. W testach regresji potwierdzić red na starym kodzie.

Obecne wyniki `875b5243b` są baseline, nie dowodem nowego wydzielenia. Testy mają
izolowany CEZ_HOME, syntetyczne sekrety, limit czasu i blokadę zewnętrznej sieci.
Próby na żywych kontach wymagają osobnego uzgodnienia, nie są wykonywane w planie.

## 8. Ryzyka i zasada zatrzymania

Największe ryzyka: rozbudowanie SDK pod szczegóły jednej platformy, ujawnienie
refresh sekretów, utrata update przy zmianie kursora, zmiana przestrzeni dedupe/lease,
deadline Discorda, niejawna aktywacja po disable oraz rollback cofający zużyty sekret.
W UI: pomylenie globalnej instalacji z połączeniem projektu, utrata szczegółu starego
linku i ukrycie połączenia wymagającego naprawy po wyłączeniu wtyczki.
Ograniczamy je wspólnym kontraktem, pionowym wycinkiem i testami starego stanu przed
przełączeniem domyślnej ścieżki.

Nie zamykamy zmiany, jeżeli test wymaga prywatnego importu, trzeba osłabić grant,
przesunąć checkpoint przed accept, oddać refresh token workerowi lub wyłączyć
działający scenariusz flags-off. To sygnał do korekty kontraktu, nie do wyjątku
zarezerwowanego dla „oficjalnej” wtyczki.
