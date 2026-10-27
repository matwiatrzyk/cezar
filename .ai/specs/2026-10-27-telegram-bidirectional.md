# Telegram: komunikacja dwukierunkowa z zadaniami cezar

Status: specyfikacja do implementacji, decyzje rozstrzygnięte. 2026-10-27, rewizja 5.
Baza zweryfikowana: `89550186a` na `cez/143115c2`, po obsłudze wysyłek Telegrama i przeniesieniu jego tokenów do sejfu. Spec rozszerza [integrację wychodzącą](2026-10-27-telegram-webhook-receivers.md); nie zmienia jej zasad dostawy, redakcji ani przechowywania sekretów.

## 1. Cel i zasada projektowa

Użytkownik dostaje w Telegramie pytanie albo powiadomienie cezar, odpowiada natywnym „Odpowiedz” i odpowiedź trafia do właściwego zadania. Następne pytania i powiadomienia o wyniku wracają przez istniejącą integrację wychodzącą do tego samego czatu, zgodnie z subskrypcjami odbiorcy. Nie jest to streaming transkryptu: dla pytania bez `attentionRequest` wysyłamy informację, że zadanie czeka, bez treści wypowiedzi agenta (§6.4).

**Zasada nadrzędna: zmiana dotyka tylko odbiorców Telegrama z włączoną komunikacją dwukierunkową.** Zadania, odbiorcy Slack/Discord/JSON i odbiorcy Telegrama używani tylko do wysyłania zachowują się dokładnie jak dziś. Kod wspólny wolno przenosić, ale nie zmieniać jego zachowania; kontrolą regresji są istniejące testy tras przechodzące bez modyfikacji oraz przegląd zachowania przed/po wydzieleniu kodu. Jedyny wyjątek w konfiguracji outbound to arbitraż „Connect chat” przy bocie zajętym przez inbound (§5.3); wysyłka outbound pozostaje bez zmian. Każde rozwiązanie, które zmienia zachowanie globalne (silnik zadań, wspólny limiter, obserwator lifecycle), jest poza zakresem i trafia do osobnego zgłoszenia (§12).

## 2. Etapy

Etapy to kolejne części pracy w ramach jednego zadania i jednej gałęzi, nie osobne PR-y. Między etapami jest punkt kontrolny: etap 2 zaczyna się dopiero, gdy wszystkie testy etapu 1 (§11.4) przechodzą, a ich wynik jest zapisany w notatkach zadania. Etap 1 jest sam w sobie użyteczny, więc gdyby prace trzeba było przerwać, gałąź po etapie 1 jest spójnym stanem.

**Schematy projektujemy od razu pod oba etapy:** grant ma pole `permissions` już w etapie 1 (kontrakt zna docelowe wartości, ale etap 1 przyjmuje wyłącznie `respond`), a plik stanu ma jeden `schemaVersion: 1`. Etap 2 nie migruje danych z etapu 1.

**Etap 1 (MVP), czat prywatny:**

- jedna osoba na powiązanie, jej własny czat prywatny z botem;
- natywne Reply na pytanie albo powiadomienie o zadaniu, które czeka na użytkownika;
- komendy `/help`, `/tasks`, `/status <task>`, `/reply <task> <tekst>`;
- działanie, gdy serwer cezar jest uruchomiony, również po zamknięciu przeglądarki;
- bezpieczne zachowanie przy restarcie, utracie sieci, cofnięciu dostępu i rotacji tokena.

**Etap 2:**

- zwykłe grupy i supergrupy bez tematów forum, wiele sparowanych osób w czacie;
- `/cancel <task>` i `/continue <task> [tekst]` z potwierdzeniem przyciskiem.

**Włączenie funkcji:** nowa zmienna `CEZ_CHAT_INBOUND=1`, domyślnie wyłączona, wymagająca także `CEZ_WEBHOOKS=1` (decyzja D1). Nazwa jest niezależna od dostawcy: ta sama flaga obejmie przyszłe dwukierunkowe integracje ze Slackiem, Discordem itp. Bez niej moduł nie uruchamia pollera, trasy z §11.1 odmawiają mutacji (503, `code: 'flag_off'`), a UI pokazuje sekcję z informacją, jak funkcję włączyć. Sama flaga niczego nie paruje ani nie uruchamia. Jawne rozpoczęcie parowania uruchamia ograniczony tryb `pairing` bez grantu; sterowanie zadaniem wymaga zatwierdzonego grantu. Zmiana env wymaga restartu, jak dla `CEZ_WEBHOOKS`. Zakaz pollera przy wyłączonej fladze dotyczy nowego odbioru, nie istniejącego, ręcznie wywoływanego Connect chat.

**Poza zakresem obu etapów:** tworzenie nowych zadań z Telegrama, wybór modelu/konta/workflow, załączniki i głos, terminal i shell, merge/push/land, akceptacja narzędzi dostawcy, publiczny webhook HTTPS, hosted cockpit, forum topics, kanały jako źródło poleceń, streaming transkryptu. Nie wprowadzamy ogólnego `/approve`: odpowiedź agentowi, akceptacja narzędzia i scalenie kodu to różne operacje.

## 3. Fakty zweryfikowane w kodzie

| Miejsce | Fakt i konsekwencja |
| --- | --- |
| `packages/cezar/src/webhooks/telegram-secrets.ts` | Token w projektowym `SecretStore`, audience tylko `cezar`, referencja z fingerprintem. Reużyć bez zmian. |
| `packages/cezar/src/webhooks/telegram-connect.ts` | Każde wywołanie robi `getMe` i niekonsumujące `getUpdates` bez offsetu. To wykrywanie czatu, nie autoryzacja człowieka. |
| `packages/cezar/src/webhooks/transport.ts` | Treść udanej odpowiedzi Telegrama jest odrzucana, więc `message_id` nie jest zachowywany. Potrzebny minimalny parser (§7). |
| `packages/cezar/src/webhooks/admission.ts:165` | `task.attention_required` wychodzi po `graceSeconds`, domyślnie 180 s, i nie wychodzi, jeśli w tym czasie użytkownik odpowie w cockpicie. Zostaje bez zmian (decyzja D2). |
| `packages/cezar/src/webhooks/lifecycle.ts:6` | `attention_required` powstaje przy przejściu do `waiting` lub zmianie `requestId`. **Zadanie może czekać bez `attentionRequest`** (agent zapytał zwykłym tekstem). Ten przypadek musi działać (§6.2). |
| `packages/cezar/src/webhooks/ownership.ts` | Lease z identyfikacją procesu i ochroną przed PID reuse. Reużyć dla locka bota (§5.1). |
| `packages/cezar/src/server/server.ts:5007` | Handler `POST /runs/:id/messages` (~50 linii): kontrola dostawcy i konta, potem send → enqueue → defer → 409. Kontrole są tylko w handlerze, więc Telegram musi je współdzielić (§6.3). |
| `packages/cezar/src/runs/store.ts` | `setLifecycleObserver` ma jednego odbiorcę, zajętego przez serwis webhooków. Nowy kod go nie zmienia. |
| `packages/web/src/routes/task-thread/ask-selections.ts` | `requestId` może się powtórzyć po Continue; sam w sobie nie identyfikuje pytania. |
| `packages/contract/src/webhooks.ts`, `packages/cezar/src/core/ask.ts` | Projekcja pytania dla webhooków gubi `multiSelect`. Odpowiedzi tylko tekstowe, bez przycisków wyboru. |
| brak | **W repozytorium nie ma mechanizmu rozwiązywania skróconych ID zadań.** Trzeba go dodać (§6.4). |

## 4. Ograniczenia Telegrama

`getUpdates` i webhook wykluczają się. Aktualizacje czekają najwyżej 24 h. Offset potwierdza wcześniejsze aktualizacje. Po tygodniu bez aktualizacji kolejne `update_id` może być losowe. `allowed_updates` jest zapamiętywane przez Telegram. Dwa równoległe `getUpdates` dla jednego bota kończą się 409. [Bot API](https://core.telegram.org/bots/api#getupdates)

Deep link `/start` przyjmuje do 64 znaków `[A-Za-z0-9_-]`. W czacie prywatnym bot dostaje wszystkie wiadomości; privacy mode dotyczy tylko grup i nie trzeba go wyłączać. [Bot features](https://core.telegram.org/bots/features#deep-linking)

Wymagamy dedykowanego bota. Nigdy nie wywołujemy `deleteWebhook`, `setWebhook` ani ujemnego offsetu. Liczby w tym specu to limity produktu, nie Telegrama.

## 5. Odbiornik

### 5.1 Jeden właściciel odbioru na bota

`TelegramInbound` w `packages/cezar/src/telegram/` należy do serwisu webhooków projektu. Działa w lokalnym cockpicie z obiema flagami, gdy istnieje aktywne powiązanie z grantem albo niewygasła sesja parowania. Bez grantu tryb `pairing` obsługuje tylko parowanie i konfigurację, nigdy komendy zadania. Ostatnia wygasła/anulowana sesja zatrzymuje poller, jeżeli nie ma aktywnych powiązań. Dodawanie osoby nie zatrzymuje istniejących grantów.

- Tożsamość to `botId` zweryfikowane przez `getMe`, nie token ani username. Maksymalnie jeden właściciel konsumpcji aktualizacji i jedno żądanie `getUpdates` na bota w danym `CEZ_HOME`.
- W `cezarHomeDir()/telegram/bots/<botId>/` tworzymy katalog 0700 i używamy `acquireOwnership(directory)` bez zmiany jego algorytmu. To on tworzy `owner.lock` i pliki pomocnicze. Oddzielny `binding.json` (0600, Zod, zapis atomowy) zawiera project identity, kanoniczny root i generację przypisania, bez sekretów. Generacja przypisania jest losowym UUID i zmienia się przy każdym nowym przypisaniu. Zapis/odczyt wiążący wykonuje wyłącznie posiadacz ważnego locka. Dry-run używa oddzielnej przestrzeni `telegram/dry-run/bots/` i fikcyjnych botów.
- Pierwsze parowanie rezerwuje przypisanie przed uruchomieniem pollera. Lock chroni proces; `binding.json` zachowuje przypisanie po jego zakończeniu. Drugi projekt dostaje 409, również gdy pierwszy nie działa. Nazwa właściciela jest rozwiązywana lokalnie z rejestru; przy jej braku UI pokazuje ID, bez ujawniania ścieżki w błędzie.
- Wyłączenie odbioru zachowuje przypisanie i granty. Osobne „Odłącz bota” (§11.1) zatrzymuje odbiór, zapisuje wyłączenie i usuwa granty/korelacje, potem zwalnia przypisanie pod lockiem. Awaria między krokami pozostawia bota przypisanego, lecz nieaktywnego; ponowienie kończy operację. Stary stan zawiera generację przypisania i nie uruchomi się po ponownym przypisaniu bota. Nie przejmujemy bota automatycznie, nawet gdy root właściciela zniknął. Dla takiego osieroconego przypisania workspace UI pozwala jawnie je zwolnić bez edycji plików (§11.1). Brak binding albo inna generacja przy istniejącym stanie projektu nigdy nie odtwarza automatycznie przypisania; wymaga parowania.
- Własność konsumpcji obejmuje również backoff, pairing i zamykanie. Utrata locka przerywa poller oraz zabrania kolejnych skutków i zapisów.
- Hosted: brak pollera, API zwraca powód `hosted`. 409 Telegrama: stan `conflict`, bez automatycznego przejmowania i bez `deleteWebhook`.

### 5.1a Kontekst projektu po restarcie

Koordynator webhooków może otworzyć serwis bez RunManagera (`webhooks/coordinator.ts`); konteksty projektów są leniwe (`server/project-context.ts`). Sam polling, nieuprawnione wiadomości i parowanie nie otwierają managera. Po uwierzytelnieniu świeżej komendy wymagającej stanu zadania adapter może otworzyć **wyłącznie własny projekt** przez istniejący mechanizm kontekstów, z jego standardowym recovery. W UI zgoda na inbound obejmuje tę możliwość wznowienia lokalnej obsługi projektu. Oczekiwanie jest ograniczone do 30 s; po timeout komenda zostaje odrzucona bez automatycznego ponowienia. Samo otwieranie kontekstu może dokończyć się jak zwykłe otwarcie projektu w cockpicie. Po recovery ponownie sprawdzamy grant, świeżość i stan zadania. Brak projektu, rootu albo gotowości → stały komunikat odmowy; nie tworzymy nowego projektu. Przy Reply brak dowodu aktualności po restarcie oznacza odmowę (§6.2).

### 5.2 Long polling

- `getUpdates` z `timeout=25`, deadline całego żądania 35 s (DNS, body, shutdown), `limit=50`, `allowed_updates=["message"]` w etapie 1 (`callback_query` dochodzi w etapie 2). Włączenie odbioru jest zgodą na zmianę `allowed_updates` dedykowanego bota.
- Reużyć istniejącą politykę transportu: przypięty DNS, brak redirectów, stały host, limit body 1 MiB. Timeout long pollingu jest osobnym parametrem wywołania; globalny timeout webhooków się nie zmienia.
- Body >1 MiB: ponowić ten sam offset z `limit=1`; jeśli dalej za duże, stan `blocked`, bez potwierdzania danych.
- Sieć/5xx: backoff z jitterem 1–60 s. 429: czekać co najmniej `retry_after`. 401 lub niezgodny fingerprint sekretu: `credentials-unavailable`. Inne 4xx: stała diagnostyka i zatrzymanie.

### 5.3 „Connect chat” i arbitraż

W tym samym procesie Connect chat dla bota należącego do inbound rejestruje kod w jego module; nie wysyła własnego `getUpdates`, także podczas backoffu. W module odróżniamy kody Connect od kodów nadawania dostępu. Dopasowanie kodu trafia do krótkiego cache (maks. 3 sesje/projekt, 5 min), żeby przetrwało odstęp między wywołaniami obecnej trasy. Odpowiedź HTTP zachowuje obecny kontrakt; TTL usuwa rejestrację. Obecny kontrakt nie wysyła osobnego anulowania do serwera; zamknięcie formularza przerywa bieżące HTTP, a cache znika najpóźniej po TTL. Wiadomość konfiguracji nie staje się komendą agenta ani grantem. Obsługa kodów następuje przed filtrem wymagającym grantu.

Przy zatrzymanym module z trwałym przypisaniem nie uruchamiamy odbioru przez Connect: pokazujemy prośbę o wznowienie inbound albo ręczne chat ID. Przy właścicielu w innym procesie/projekcie Connect chat odmawia z 409 i proponuje ręczne chat ID. Nie dodajemy IPC ani drugiego pollera. Dla bota bez inbound zachowujemy istniejące wykrywanie bez offsetu, ale jego żądanie `getUpdates` korzysta z tego samego krótkiego locka bota; nie tworzy trwałego przypisania. Uruchomienie inbound czeka na zwolnienie krótkiego locka albo zwraca konflikt do ponowienia przez użytkownika. Brak dostępu do locka oznacza odmowę wykrywania, nie blokadę ręcznego zapisu odbiorcy. `getMe` może poprzedzać lock, bo nie konsumuje aktualizacji.

## 6. Rozmowa

### 6.1 Co poller przyjmuje

Tylko `message` z polem `text` w czacie prywatnym, `from.is_bot === false`, bez `forward_origin`, `via_bot`, `sender_chat`, edycji i mediów. W etapie 2 filtr dopuszcza także grupy opisane w §10 oraz osobno obsługuje callbacki i zdarzenia administracyjne przed filtrem tekstu. Reszta jest potwierdzana offsetem i ignorowana. ID bota, czatu i osoby normalizujemy do kanonicznych dziesiętnych stringów po walidacji safe integer; nie używamy operacji 32-bitowych. Wiadomość od osoby bez aktywnego grantu dostaje wyłącznie ogólną instrukcję parowania, najwyżej raz na minutę na czat, bez żadnych danych projektu.

**Wiadomości przeterminowane:** polecenie starsze niż 15 minut (pole `date`) albo sprzed włączenia odbioru (`acceptAfter`) nie jest wykonywane. Dla uprawnionej osoby bot odpisuje: „Wiadomość jest zbyt stara lub pochodzi sprzed włączenia dostępu. Nie przekazano jej. Sprawdź stan: /status <task>”. Nie zakładamy przyczyny opóźnienia; dane zadania podajemy tylko po autoryzacji. Odrzucamy też czas ponad 60 s w przyszłości. Przy wielu takich wiadomościach z jednej partii wysyła jedną zbiorczą odpowiedź.

### 6.2 Natywne Reply

Odpowiedź rozpoznajemy po `(botId, chatId, reply_to_message.message_id)` w trwałej korelacji z dostawy (§7). Nie ufamy cytowanemu tekstowi ani tytułowi zadania.

Korelacja przechowuje: `receiverId`, `deliveryRevision`, generację przypisania i włączenia, `runId`, typ zdarzenia, `sequence`, `episodeId`, `continuation` ze źródłowego snapshotu oraz, jeśli było, `requestId` i `askedAt`. Do odpowiadania służą wyłącznie korelacje `task.attention_required`; Reply na pozostałe powiadomienia podaje status/pomoc i nie odpowiada automatycznie na późniejsze pytanie.

**Aktualność** sprawdzamy w adapterze tuż przed przekazaniem wiadomości:

- zadanie nadal ma status `waiting`;
- zgadzają się `continuation`, generacje i `deliveryRevision`, zadanie nie jest zarchiwizowane;
- serwis webhooków potwierdza bieżący `episodeId` i sekwencję przechwyconego pytania. Sama największa sekwencja nie wystarcza: nie każdy lifecycle generuje webhook. Reużyć istniejący model episodes/freshness przez wąski odczyt serwisu, bez dodatkowego obserwatora lub pola `RunRecord`;
- brak dowodu wskutek restartu, capture gap albo kompaktowania oznacza odmowę „Nie mogę potwierdzić aktualności. Sprawdź /status i użyj /reply”. Nie rekonstruujemy pewności wyłącznie z `waiting`;
- jeśli korelacja ma `requestId`, bieżący `attentionRequest` ma ten sam `requestId` i `askedAt`.

To obejmuje oba przypadki: pytanie strukturalne (`CEZ:ASK`) i pytanie zadane zwykłym tekstem.

Wynik:

- aktualne → wiadomość trafia do zadania (§6.3);
- nieaktualne → „To pytanie jest już nieaktualne. Aktualny stan: /status <task>”; bez przekierowania na nowe pytanie;
- zadanie zakończone → bez automatycznego Continue, z informacją, że wznowienie jest w cockpicie (w etapie 2 przez `/continue`);
- brak korelacji → „Nie mogę przypisać tej odpowiedzi. Użyj /reply <task> …”. Nie zgadujemy ostatniego zadania.

Wiadomość bez Reply i bez komendy nie trafia do żadnego zadania; bot odpowiada krótką pomocą.

**Znane ograniczenie:** gdy w tej samej chwili ktoś odpowie w cockpicie, obie odpowiedzi mogą trafić do agenta. Ten sam wyścig istnieje dziś między dwiema kartami cockpitu. Poprawka globalna jest w §12.

### 6.3 Przekazanie do zadania

Wydzielić z handlera `POST /runs/:id/messages` funkcję (np. `deliverUserMessage` w `packages/cezar/src/server/run-messages.ts`) zawierającą obecną logikę: kontrolę dostawcy i konta, limity kolejki oraz drabinę send → enqueue → defer → odmowa. Handler HTTP woła tę funkcję; idempotencja HTTP i kształty odpowiedzi zostają w handlerze. **Pierwszy krok to czyste przeniesienie kodu; późniejsza opcjonalna końcowa kontrola adaptera (§9.1) pozostaje pusta dla HTTP:** `queued-messages.test.ts`, `message-receipts.test.ts` i pozostałe testy tras przechodzą bez zmian.

Adapter Telegrama woła tę samą funkcję. Nie wolno wołać `manager.sendMessage` bezpośrednio, `deliverMessage` z `run.ts` ani trasy HTTP (także przez `app.request`).

Tekst trafia do agenta z prefiksem `[via Telegram] `, bez nazwy użytkownika (nazwa jest niezaufanym wejściem). Prefiks jest też widoczny w wątku zadania w cockpicie.

Odpowiedź bota odzwierciedla wynik funkcji: „Przekazano”, „Dodano do kolejki”, „Czeka na start sesji” albo „Odrzucono: <stały powód>”. Żadna nie oznacza, że agent wykonał polecenie.

### 6.4 Komendy

Parser zamkniętego słownika, komenda tylko na początku tekstu (entity `bot_command`); nieznana komenda → pomoc, nigdy wiadomość do agenta. Sufiks `@username` musi wskazywać tego bota, porównanie bez rozróżniania wielkości liter. Tekst do 4000 jednostek UTF-16 przed prefiksem; przekroczenie → odmowa bez obcinania polecenia. `/reply` wymaga niepustego tekstu i statusu `waiting`, bez uruchamiania Continue.

| Komenda | Etap | Zachowanie |
| --- | --- | --- |
| `/help` | 1 | lista dostępnych komend |
| `/tasks` | 1 | do 10 najnowszych niearchiwalnych zadań projektu: krótkie ID, status, tytuł |
| `/status <task>` | 1 | status i metadane Standard, dla `waiting` pytania strukturalne; brak `attentionRequest` → „Zadanie czeka; treść wypowiedzi sprawdź w cockpicie”. Osobny renderer komend współdzieli bezpieczne prymitywy formatowania z `webhooks/telegram.ts`, bez wymyślania zdarzenia webhooka |
| `/reply <task> <tekst>` | 1 | jak Reply, ale bez korelacji; dla czekającego zadania odpowiada na bieżące pytanie |
| `/cancel <task>` | 2 | podgląd + przycisk „Potwierdź”, ważny 120 s |
| `/continue <task> [tekst]` | 2 | podgląd z dostawcą/kontem i ostrzeżeniem o koszcie + przycisk, ważny 120 s |

Nie pobieramy transkryptu ani ostatniej wypowiedzi agenta do Telegrama w tym zadaniu. Powiadomienie o zwykłym zakończeniu tury umożliwia Reply, ale nie zawiera pytania; UI i pomoc wyjaśniają ograniczenie. `/status` z pytaniem strukturalnym zapisuje po udanym wysłaniu taką samą korelację jak §7, jeśli istnieje wiarygodny bieżący episode. Przy jej braku nadal działa jawne `/reply`. Wszystkie odpowiedzi stosują escapowanie, neutralizację wzmianek i limit 4096 znaków; `/tasks` skraca tytuły i liczbę pozycji, nigdy ID.

**Skrócone ID (nowe):** pełny UUID albo prefiks co najmniej 8 znaków pasujący do dokładnie jednego niearchiwalnego zadania projektu. Brak lub kilka dopasowań → błąd z prośbą o dłuższy prefiks. Resolver jest zwykłą funkcją w module Telegrama.

## 7. Korelacja wysyłki

W `transport.ts` dla formatu `telegram.v1` sparsować z udanej odpowiedzi wyłącznie `result.message_id` i `result.chat.id`; resztę body odrzucić jak dziś. Serwis webhooków, gdy dostawa jest `delivered` i odbiorca ma włączoną komunikację dwukierunkową, zapisuje korelację (§6.2) w stanie modułu Telegrama. Korelacja powstaje w serwisie przy domknięciu dostawy, więc obserwator lifecycle zostaje bez zmian. Brak `message_id` oznacza brak korelacji, a nie błąd dostawy. Korelacje żyją 7 dni, najwyżej 5000 na bota (najstarsze odpadają).

Zmiana chat ID, formatu, tokena albo `deliveryRevision` unieważnia stare korelacje. Parser odpowiedzi sprawdza `ok`, dodatnie `message_id` i zgodność numerycznego czatu z powiązaniem. Awaria między wysyłką a zapisem korelacji może pozostawić wiadomość bez korelacji: nie ponawiamy dostawy tylko po to, by ją odtworzyć; Reply dostaje pomoc z §6.2. Nie zmieniamy gwarancji istniejącej kolejki outbound.

## 8. Parowanie i uprawnienia

### 8.1 Przepływ (etap 1)

1. W szczegółach aktywnego, przetestowanego odbiorcy Telegrama (profil Standard, subskrypcja `task.attention_required`) użytkownik klika „Enable two-way”. UI wyjaśnia, że odpowiedzi sterują agentem i mogą prowadzić do zmian w kodzie i kosztów, oraz wymaga potwierdzenia, że bot jest dedykowany.
2. Serwer generuje kod: 24 losowe bajty base64url, ważny 5 minut, trzymany tylko w pamięci jako hash. Maks. 3 kody na projekt. Restart unieważnia niedokończone parowanie.
3. Po zapisaniu przypisania i uzyskaniu locka poller startuje w trybie pairing, bez prawa wykonywania komend. Użytkownik otwiera `t.me/<bot>?start=<kod>` i naciska Start. Poller wymaga czatu prywatnego, `from.is_bot === false` i `chat.id === receiver.telegramChatId === from.id` (po normalizacji ID).
4. Cockpit pokazuje kandydata: numeryczne ID, nazwę i username (jako etykiety nieautorytatywne). Użytkownik klika „Zatwierdź”. Kod porównawczy nie jest potrzebny, bo czat prywatny został wcześniej potwierdzony testem dostawy, a ID kandydata musi być równe chat ID.
5. Grant `(project, botId, chatId, userId)` jest zapisany; bot wysyła potwierdzenie.

Kod jest jednorazowy: pierwsze poprawne `/start` wiąże kandydata, ponowienie przez tę samą osobę jest idempotentne, inna osoba nie zastępuje kandydata. Confirm ponownie sprawdza ważność, rewizję odbiorcy, bota, chat ID, test oraz kandydata. Anulowanie, wygaśnięcie i zmiana konfiguracji unieważniają kod. Grant nie przechodzi na innego bota ani inny czat. Rotacja tokena tego samego bota zawiesza odbiór do udanego testu i ponownego włączenia; granty zostają.

### 8.2 Uprawnienia

Etap 1 ma jeden poziom: **`respond`**, czyli `/tasks`, `/status`, Reply i `/reply`. Etap 2 dodaje `cancel` i `continue`, domyślnie wyłączone, oraz parowanie w grupach (§10).

Grant jest związany także z `receiverId` i generacją włączenia. Dopuszczamy jedno aktywne powiązanie inbound na `(botId, chatId)`; drugi odbiorca dostaje 409. `respond` daje odczyt i odpowiedzi do wszystkich niearchiwalnych zadań tego projektu, niezależnie od filtra powiadomień odbiorcy. UI pokazuje ten zakres przed zatwierdzeniem. `cancel` i `continue` wymagają również `respond`. Zmiana bota lub czatu wymaga nowego parowania; grant nie wraca po przywróceniu starego chat ID.

Uprawnienia nadaje i cofa wyłącznie cockpit. Sprawdzamy je przy każdej wiadomości, tuż przed skutkiem. Cofnięcie działa natychmiast, także dla już pobranej partii.

Odbiorca przełączony na Minimal, odsubskrybowany z `attention_required`, wstrzymany albo wyłączony automatycznie zawiesza odbiór. Nie wprowadzamy częściowych uprawnień zależnych od profilu. `acceptAfter` jest per powiązanie, a grant ma własne `approvedAt`/generację. Nowy grant, ponowne włączenie albo zmiana uprawnień wyznacza nową granicę czasową; komendy wcześniejsze niż ta granica są odrzucane. Przy ponownym włączeniu niezmienionego bota/czatu zachowane granty są jawnie przypinane do nowej generacji włączenia w tym samym zapisie; grantów cofniętych ani zmienionego chat ID nie odtwarzamy. Zwykły restart zachowuje granicę, by świeże wiadomości z czasu krótkiej niedostępności mogły działać. Cofnięcie ostatniego grantu wyłącza powiązanie. Wiele czatów jednego bota współdzieli poller, ale zawieszenie jednego nie zatrzymuje pozostałych.

## 9. Stan, trwałość i bezpieczeństwo

### 9.1 Plik stanu

`.ai/cezar/webhooks/telegram/<botId>.json` (w dry-run pod istniejącą ścieżką dry-run), Zod `schemaVersion: 1`. Zapis atomowy tmp/fsync/rename i synchronizacja katalogu według istniejącego storage, ochrona symlinków, katalog 0700, pliki 0600. Stan zawiera project identity, kanoniczny root, generację przypisania, `configGeneration`, powiązania odbiorców (enabled, generacja, acceptAfter), granty (permissions, generacja, approvedAt), epokę, `nextOffset`, `lastUpdateAt` (przy inicjalizacji stan probing i wartość null), korelacje i dziennik. Bez tokena i treści wiadomości. Wszystkie ID i etykiety mają limity w schemacie (etykiety do 256 znaków, identyfikatory wewnętrzne do 128), aby limity liczby wpisów ograniczały również pamięć. Nazwy osób są tylko ograniczonymi etykietami, nie kluczami autoryzacji.

**Jeden zapisujący:** wszystkie zmiany tego pliku (poller, API, korelacja outbound, odzyskiwanie) przechodzą przez jedną kolejkę read-modify-write modułu przy ważnym locku. Snapshot nie może nadpisać równoległego cofnięcia grantu. Kontrole przed skutkiem ponownie czytają aktualny stan; przy asynchronicznych kontrolach konta należy umożliwić adapterowi końcową kontrolę grantu/aktualności tuż przed drabiną dostarczenia, domyślnie pustą dla HTTP. Nie zmienia to zachowania klientów HTTP ani nie rezerwuje globalnie pytania. Nie trzymamy kolejki zapisów podczas sieci lub otwierania kontekstu. Błąd zapisu → `blocked`, bez kolejnych skutków i bez potwierdzania niezapisanego offsetu.

Limit UTF-8 pliku 2 MiB, maks. 5000 korelacji (TTL 7 dni), 500 zakończonych wpisów dziennika, 100 grantów i 20 powiązań na bota. Przed zapisem usuwamy wygasłe/najstarsze korelacje i najstarsze zakończone wpisy. Nie usuwamy `claimed`, grantów ani offsetu, aby zmieścić zapis. Nadal za duży → `blocked`; nowa konfiguracja przekraczająca limit → 409 przed zapisem. Przy sekwencyjnej obsłudze istnieje najwyżej jeden nierozstrzygnięty `claimed` na bota.

Brak/uszkodzenie/obca tożsamość pliku oznacza brak aktywnych grantów. Uszkodzonego pliku nie nadpisujemy pustym; UI wyjaśnia stan i udostępnia jawny reset (§11.1), który unieważnia dostęp i zaczyna od nowego parowania. Nie usuwamy powiązania innego projektu. Reset/odłączenie działa pod lockiem, nigdy nie omija aktywnego właściciela.

### 9.2 Przetwarzanie partii i awarie

Przetwarzamy aktualizacje sekwencyjnie. Kluczem jest `(epoch, update_id)`, nie samo `update_id`. Przed pierwszym odpytywaniem po restarcie, jeszcze pod lockiem, każde zachowane `claimed` zamieniamy atomowo na `uncertain` z przesunięciem `nextOffset` co najmniej do `updateId + 1`. Nie wykonujemy akcji ponownie, także gdy awaria nastąpiła przed jej faktycznym wywołaniem. Jeśli zapis recovery nie powiedzie się, odbiór pozostaje zablokowany.

Dla każdej aktualizacji:

1. Sprawdzić epokę i zapisany dziennik. Istniejący `claimed` obsłużyć jak recovery powyżej; istniejący wynik lub `update_id < nextOffset` oznacza duplikat bez nowego skutku.
2. Obsłużyć zdarzenia parowania/administracyjne; dla komend sprawdzić typ, uprawnienia, granicę czasową i parser. Otworzyć kontekst tylko zgodnie z §5.1a. Tuż przed skutkiem ponownie sprawdzić grant, konfigurację i zadanie.
3. Dla zmiany zadania zapisać trwałe `{epoch, updateId, actionId?, runId, state: 'claimed', ...audit}` i poczekać na powodzenie zapisu. Dopiero potem wywołać współdzieloną funkcję wiadomości/anulowania/wznowienia. Wynik i `nextOffset = updateId + 1` zapisać atomowo. Wyjątek o niepewnym skutku daje `uncertain`, nie retry akcji. Nieudany zapis wyniku zatrzymuje odbiór; pozostawiony `claimed` zabezpiecza restart.
4. Dla komend odczytu i odrzuceń zapisać wynik audytu oraz offset przed zakolejkowaniem odpowiedzi. Ignorowane media/edycje/nieadresowane wiadomości tylko przesuwają offset. Parowanie i zmiany administracyjne zapisują swój stan z offsetem; kandydat jest w pamięci, więc po awarii niedokończone parowanie zaczyna się od nowa.

Kolejny `getUpdates` używa tylko trwale zapisanego offsetu. Gwarancja: najwyżej jedna automatyczna próba skutku na aktualizację w epoce, nie exactly-once. Gwarancja opiera się na istniejących gwarancjach storage; nie obejmuje ręcznego przywrócenia starego backupu. Reset nie odtwarza grantów, ustawia nową granicę czasową i wymaga parowania.

Wpis audytu: ograniczony identyfikator, czas, epoch/updateId, bot/chat/user ID, opcjonalny receiverId (brak dla nieznanego czatu), opcjonalny runId (brak przy nieznanym zadaniu), rodzaj zamkniętego zbioru (`reply`, `answer`, `status`, `tasks`, `cancel`, `continue`, `unknown_command`), wynik (`accepted`, `queued`, `deferred`, `rejected`, `uncertain`) i stały kod powodu. Bez tekstu polecenia, tokena i surowych błędów. Rejestrujemy komendy przyjęte i odrzucone; niezwiązany ruch ignorujemy. Nadmiar ruchu ponad limit może mieć jeden zbiorczy wpis z licznikiem/minutę, żeby nie wyprzeć całego audytu.

Po recovery bot może wysłać „Nie wiem, czy wiadomość dotarła do zadania <id>. Sprawdź /status <id>”, wyłącznie przy nadal ważnym grancie. Powiadomienie jest best-effort; trwały wynik `uncertain` pozostaje w cockpicie. Nie ma trwałej kolejki wykonywalnych akcji ani odpowiedzi bota.

**Epoka i długa cisza:** `lastUpdateAt` to czas odebrania niepustej partii aktualizacji, nigdy udanego pustego pollu; `lastSuccessfulPollAt` jest osobnym stanem diagnostycznym. Gdy od ostatniej aktualizacji minęło 6 dni, najpierw zakończyć recovery `claimed`, następnie trwale utworzyć nową losową epokę z `nextOffset: null` i stanem `probing`. Żądania idą bez offsetu aż do pierwszej niepustej partii. W `probing` nie tworzymy kolejnej epoki co poll ani po restarcie. Pierwszą partię analizujemy już bez porównywania z offsetem poprzedniej epoki; każdy wpis przechodzi zwykły filtr daty/acceptAfter, a po pierwszym zapisanym rozstrzygnięciu epoka staje się aktywna. Stare wpisy poprzedniej epoki pozostają tylko audytem. Żadne polecenie sprzed 15 minut nie wykonuje się, również przy losowo niższym ID. `acceptAfter` nie jest resetowane samą zmianą epoki.

### 9.3 Limity i wysyłka odpowiedzi

Odpowiedzi idą przez istniejącą politykę transportu, ale osobny, ograniczony dispatcher w pamięci: do 100 wiadomości/bota i 10/czat, tekst do 4096 znaków, TTL 2 min, maks. 3 próby. 1 wiadomość/s/czat i maks. 10/s/bota; 429 odkłada wysyłkę co najmniej o `retry_after` bez blokowania pollera i przetwarzania innych aktualizacji. Jeśli termin wykracza poza TTL, odpowiedź wygasa. Stałe błędy nie są ponawiane. Przepełnienie odrzuca najnowszą odpowiedź i aktualizuje diagnostykę; nie ponawia akcji zadania. Po restarcie odpowiedzi mogą przepaść, a niepewna odpowiedź transportu może spowodować duplikat komunikatu bota, nigdy automatyczne powtórzenie polecenia.

Tuż przed wysłaniem danych zadania ponownie sprawdzić grant i generacje; revoke usuwa oczekujące odpowiedzi/potwierdzenia. Już wysłanych wiadomości nie cofamy. `answerCallbackQuery` ma oddzielną szybką, ograniczoną ścieżkę, aby nie czekał za `sendMessage`.

Wejście: do 20 komend/min/użytkownika i 100/min/bota, mapy limiterów ograniczone do 1000 kluczy z TTL 10 min. Nieuprawnione osoby dostają wyłącznie pomoc, maks. raz/min/czat; nadmiar komend maks. jeden komunikat limitu/min/czat. Nadal potwierdzamy odrzucone aktualizacje po zapisaniu offsetu. **Limiter i kolejka webhooków pozostają bez zmian**; dwa strumienie mogą wspólnie otrzymać 429 i respektują odpowiedzi Telegrama.

### 9.4 Prywatność

Nie logujemy surowych aktualizacji, kodów parowania ani tokena. Treść odpowiedzi trafia wyłącznie do zadania, jak wiadomość z cockpitu. Telemetria nie dostaje ID użytkownika ani czatu, tekstów ani nazw. Linki do zadań idą zgodnie z obecną polityką linków (tylko hosted).

### 9.5 Stany odbioru

| Stan | Wejście | Wyjście |
| --- | --- | --- |
| `disabled` | domyślny; wyłączenie przez użytkownika | „Enable two-way” po spełnieniu warunków |
| `pairing` | kod, lock, warunki konfiguracji; grant nie jest wymagany | zatwierdzenie → `active`; wygaśnięcie ostatniej sesji → `disabled`, jeśli nie ma aktywnych grantów |
| `active` | grant, lock, sekret, aktywny odbiorca | każda przyczyna niżej |
| `backoff` | sieć, 5xx, 429 | timer |
| `suspended` | odbiorca paused/disabled/Minimal, zmiana chat ID, bot usunięty z czatu | naprawa i ponowne włączenie w UI |
| `credentials-unavailable` | 401, brak lub zmiana sekretu | nowy token, test, ponowne włączenie |
| `conflict` | 409 Telegrama, lock innego projektu | usunięcie konfliktu i ponowne włączenie |
| `blocked` | odpowiedź za duża, niekompatybilny stan | naprawa i ponowne włączenie |
| `stopped` | zamknięcie serwera | start serwera, jeśli zapisano włączenie i są granty |

Stany odbiorcy są osobne od zdrowia wspólnego pollera; API pokazuje oba. `conflict`/`blocked` są zapisywane jako zatrzymanie wymagające ponownego włączenia, o ile moduł ma lock i może zapisać stan. Gdy zapis jest niemożliwy, diagnostyka jest w pamięci; ponowny start musi przejść te same kontrole, bez czyszczenia stanu, przejmowania locka lub wykonywania claimed. Shutdown: zatrzymać dopływ akcji, przerwać long poll/dispatcher i timery; maks. 5 s na domknięcie pracy. Lock zwolnić dopiero, gdy nie ma wykonawcy mogącego jeszcze wywołać skutek lub zapisać stan. Przy niedomknięciu pozostawić lock do odzyskania po śmierci procesu. Boot nie czeka na sieć.

## 10. Etap 2: grupy, `/cancel`, `/continue`

### 10.1 Grupy

Obsługujemy `group` i `supergroup` bez forum. Źródła `channel`, `sender_chat`, anonimowi administratorzy i wiadomości z tematów są odrzucane. Privacy mode nie wymaga wyłączenia. Przyjmujemy Reply na wiadomość tego bota i komendy z `@botUsername`; komenda adresowana do innego bota jest ignorowana nawet wewnątrz Reply. `my_chat_member` i pola migracji są obsługiwane przed filtrem tekstowym; `allowed_updates` obejmuje `message`, `callback_query`, `my_chat_member`.

Parowanie zaczyna się przy konkretnym przetestowanym odbiorcy grupowym. Kandydat otwiera kod w prywatnym czacie z botem, gdzie `chat.id === from.id`; **nie** porównujemy prywatnego chat ID z ID grupy. Kod już wiąże receiver/grupę, nie można zmienić celu w confirm. Pierwszy kandydat blokuje kod; bot pokazuje mu sześciocyfrowy kod porównawczy, a cockpit ten sam kod i numeryczne ID osoby. Zatwierdzenie wymaga `comparisonVerified: true`; grant dotyczy grupy, a nie prywatnego czatu użytego do parowania. Kod porównawczy służy człowiekowi, nie zastępuje losowego tokena parowania. Nazwa ani uprawnienia administratora nie autoryzują osoby.

**Widoczność:** wszyscy członkowie grupy mogą zobaczyć publikowane tam dane projektu, również bez grantu. Grant ogranicza sterowanie, nie czytanie wiadomości. UI wymaga potwierdzenia `groupVisibilityAccepted: true` przed włączeniem/parowaniem grupy; nie obiecujemy prywatnych odpowiedzi. Nieuprawniona komenda sama nie ujawnia nowych danych. Cofnięcie grantu nie usuwa historii Telegrama. Migracja grupy do supergrupy i usunięcie bota zawieszają powiązanie, zwiększają generację i unieważniają korelacje/przyciski; nowy chat ID wymaga nowego testu i parowania. Nie przenosimy grantów automatycznie.

### 10.2 Potwierdzanie akcji

Wydzielić logikę handlerów `cancel` i `continue` jak w §6.3, z zachowaniem wyników i kontroli HTTP. `/continue` używa zapisanego dostawcy, modelu i konta; przy braku konta nie wybiera innego. Adapter może odmówić bardziej restrykcyjnie, bez zmiany fallbacków HTTP. Sam zakaz nadpisywania modelu nie oznacza zakazu kontynuacji na zapisanym modelu — zachować rzeczywiste reguły silnika.

Komenda tworzy podgląd, nie skutek. `callback_data`: losowe 24 bajty base64url (bez treści i identyfikatorów zadania), max. 100 potwierdzeń/bota i 5/użytkownika; TTL 120 s od utworzenia, bez przedłużania przy retry. Obiekt w pamięci wiąże actionId, rodzaj, tekst Continue, projekt, bot/receiver/chat/user, runId, continuation, stan oraz fingerprint zapisanego runnera/modelu/konta, generację grantu/włączenia i deliveryRevision. Przycisk pojawia się tylko przy nadal ważnym podglądzie. Restart unieważnia wszystkie obiekty.

Callback musi pochodzić od tej samej osoby i z tej samej wiadomości potwierdzenia w tym samym czacie; inline callback bez `message` odrzucamy. Nie używamy daty starej wiadomości bota jako czasu kliknięcia; świeżość wyznacza TTL obiektu. Ponownie sprawdzamy grant, stan, konfigurację i uprawnienia. Zmiana któregokolwiek warunku wymaga nowego podglądu.

Przed pierwszym `await` wykonania atomowo oznaczamy obiekt jako zajęty; drugie kliknięcie (nawet z innym updateId) nie tworzy drugiego skutku. Następnie trwały `claimed` z actionId według §9.2, końcowa kontrola i wywołanie współdzielonej funkcji. Po wyniku obiekt jest zużyty. Błąd zapisu nie przywraca przycisku do wykonania. Po awarii stary callback jest nieważny, a dziennik rozstrzyga niepewny wynik.

Każdy obsłużony callback, także wygasły/odrzucony, dostaje próbę `answerCallbackQuery`; nie ujawniamy danych zadania obcej osobie. Wyłączenie przycisków przez edycję wiadomości jest best-effort, a bezpieczeństwo zapewnia stan serwera. Revoke unieważnia oczekujące obiekty natychmiast.

## 11. Kontrakt HTTP, UI, plan i testy

### 11.1 Trasy

Rodzina tras projektu w łańcuchu, pod `/api/v1/telegram` i `/api/v1/p/:projectId/telegram`. Schematy najpierw w `packages/contract`, walidacja przez trio z `validators.ts`, wpis w `BACKWARD_COMPATIBILITY.md` §2.

| Trasa | Request | Response |
| --- | --- | --- |
| `GET /` | — | dostępność/powód, przypisania botów, zdrowie pollera, stan i generacja per odbiorca, granty, `revision` per bot |
| `GET /activity` | `receiverId?`, `before?`, `limit` 1–100 (domyślnie 50) | wpisy audytu, opcjonalny `nextCursor` |
| `DELETE /bots/:botId/binding` | `expectedRevision` w query | `{ disconnected: true }`, `revision`; procedura §5.1 |
| `POST /bots/:botId/reset` | `expectedRevision`, `confirmReset: true` | `{ reset: true }`, `revision`; wyłączenie, usunięcie grantów/korelacji, nowa epoka i granica czasowa; zachowuje własne przypisanie |
| `POST /pairings` | `receiverId`, `expectedRevision`, `dedicatedBot: true`, w grupie `groupVisibilityAccepted: true` | `pairingId`, `expiresAt`, `deepLink` |
| `GET /pairings/:id` | — | `waiting` / `candidate` (z danymi kandydata, w grupie kod porównawczy) / `confirmed` / `expired`, `revision` |
| `POST /pairings/:id/confirm` | `expectedRevision`, `candidateUserId`, w grupie `comparisonVerified: true` | grant, `revision` |
| `DELETE /pairings/:id` | — | `{ cancelled: true }` |
| `PATCH /receivers/:id` | `expectedRevision`, `enabled`, dla włączanej grupy `groupVisibilityAccepted: true` | stan, `revision`; `enabled: true` ponownie sprawdza wszystkie warunki |
| `DELETE /grants/:id` | `expectedRevision` w query | `{ revoked: true }`, `revision` |

Błędy: `{ error, code }`; 400, 404, 409 (rewizja, właściciel bota, stan), 429 z `Retry-After`, 503 (brak sekretu, `flag_off`, `webhooks_off`, `hosted`). `GET /` działa także przy wyłączonej fladze i zwraca `available: false` z powodem, żeby UI mogło wyjaśnić, jak włączyć funkcję. Grant ma `permissions` od etapu 1. Etap 2 dodaje `permissions` do `POST /pairings/:id/confirm` (w etapie 1 zawsze `['respond']`) oraz `PATCH /grants/:id` (`expectedRevision`, `permissions`), który podnosi generację grantu i unieważnia oczekujące potwierdzenia.

`revision` jest nieprzezroczystym stringiem **per bot**, nie globalnym licznikiem projektu. `GET /` zwraca ją przy każdym bocie; receiver/grant wskazuje botId. To SHA-256 kanonicznej reprezentacji: generacja przypisania, trwała losowa `configGeneration` i rewizje powiązanych odbiorców outbound. Każda mutacja konfiguracji inbound nadaje nową configGeneration w tym samym zapisie; offset/audyt/korelacje jej nie zmieniają. Mutacje jednego bota są serializowane pod jego lockiem, sprawdzają expectedRevision ponownie po uzyskaniu kolejki. Różne boty mogą zmieniać się niezależnie. Nowe parowanie zapisuje nową configGeneration przed wydaniem kodu; kandydat z /start nie zmienia konfiguracji, ale confirm sprawdza jego tożsamość i TTL osobno. GET parowania zwraca aktualną revision. Dla brakującego stanu hash obejmuje jawny znacznik missing; dla uszkodzonego — hash ograniczonego do limitu odczytu surowego pliku (plik ponad limit nie daje rewizji resetu, dopóki bezpieczny strumieniowy hash nie zostanie policzony). Reset sprawdza niezmienność bajtów pod lockiem, nie zgaduje grantów. Dla drugiego procesu posiadającego lock mutacje zwracają 409, bez IPC.

Dla usuniętego/nieistniejącego projektu dodatkowa **workspace-level**, jednokrotnie montowana trasa `DELETE /api/v1/telegram/bot-bindings/:botId` z `expectedRevision` i `confirmOrphanRelease: true` w query. Widok diagnostyczny `GET /api/v1/telegram/bot-bindings` zwraca tylko botId, tożsamość/nazwę projektu, orphaned i rewizję przypisania, bez rootów i sekretów. Brak flagi nie blokuje odczytu. Zwolnienie wymaga local mode, obu flag, braku projektu w rejestrze lub niedostępnego rootu, zdobycia locka (nigdy przejęcia żywego procesu) i ponownego sprawdzenia rewizji. Usuwa wyłącznie binding, nie dotyka niedostępnego repo. Przywrócony stary projekt nie uruchomi się, bo jego generacja nie ma już przypisania. Te dwie trasy mają własne schematy i nie mają aliasu projektowego. Test: znikający root, żywy właściciel, zwolnienie i powrót starego katalogu.

Wszystkie wymienione mutacje, w tym reset i odłączenie, wymagają obu flag i local mode. Przy flagach wyłączonych nie działa odbiór; UI wyjaśnia, że trwałe sprzątanie wymaga ponownego startu z flagami. Endpointy GET nie uruchamiają pollera ani recovery managera, zwracają tylko bezpieczny stan. Schematy błędów, wszystkich stanów, audytu i dodatkowych pól etapu 2 również należą do kontraktu.

### 11.2 UI

Sekcja „Two-way communication” w szczegółach odbiorcy Telegrama: warunki (Standard, `attention_required`), przycisk włączenia z opisem skutków, link parowania, kandydat do zatwierdzenia, lista osób z „Revoke”, stan odbioru z czasem ostatniego udanego pollu i opisem błędu. Nowa sekcja używa istniejącego busa subskrypcji, bez `refetchInterval` i bez nowego WebSocket. Temat `telegram-inbound` publikuje wyłącznie ogólne unieważnienie danych (bez project/bot/user/chat ID, kodów i nazw), maks. raz/s przy zmianie, tylko przy subskrybentach. Otwarty widok odbiera sygnał i odświeża swoje GET; zamknięcie zwalnia subskrypcję. Subskrypcja, reconnect i odzyskanie focusu wymuszają odczyt, żeby nie zgubić zmiany. Sekretne dane parowania nigdy nie idą przez bus. Wyłączenie flagi/hosted nie tworzy subskrypcji. Częstotliwość diagnostycznych aktualizacji ostatniego pollu ograniczyć do raz/30 s, bez ogłaszania każdej przez czytnik. Region `aria-live` tylko dla linii stanu. Etykieta „Connected” dopiero po zatwierdzeniu.

**Dziennik aktywności:** przez `GET /activity`, stronicowana lista ostatnich akcji z Telegrama (czas, osoba jako etykieta + numeryczne ID, zadanie, akcja, wynik), bez treści wiadomości. Pozwala sprawdzić, kto i kiedy sterował zadaniem. Wyniki niepewne (§9.2) są wyróżnione.

**Wątek zadania:** wiadomość z prefiksem `[via Telegram]` jest zwykłą wiadomością użytkownika; nie dodajemy nowego typu zdarzenia.

### 11.3 Plan etapu 1

1. Wydzielenie `deliverUserMessage` (§6.3). Ten krok to punkt kontrolny na tej samej gałęzi i warunek następnych: wszystkie testy tras przechodzą bez zmian.
2. Stan i przypisanie bota, lock, epoki i dziennik, z testami awarii i serializacji. Rewizje konfiguracji per bot według §11.1, bez nowego globalnego rejestru.
3. Poller i parser, integracja z Connect chat.
4. Korelacja wysyłki.
5. Trasy, kontrakt, parowanie.
6. Rozmowa: Reply, komendy, resolver ID, odpowiedzi bota.
7. UI, dokumentacja: ten spec (status), `packages/cezar/docs/webhooks.md`, strona funkcji w `docs/site` (zgodnie z `.ai/skills/cezar-docs/SKILL.md`), `BACKWARD_COMPATIBILITY.md`. `CEZ_CHAT_INBOUND` trafia do `.env.example` (obok `CEZ_WEBHOOKS`) i do tabeli env w `docs/reference.md` w tym samym commicie co jej pierwsze użycie; opis mówi, że flaga dotyczy wszystkich przyszłych dwukierunkowych integracji czatowych.

### 11.4 Testy etapu 1

Scenariusze:

1. Pełny obieg: Connect chat → test → włączenie → parowanie → pytanie → Reply → wiadomość w zadaniu z prefiksem → kolejne pytanie w tym samym czacie.
2. Pytanie zadane zwykłym tekstem (bez `attentionRequest`) → Reply działa.
3. Reply na stare pytanie po Continue z tym samym `requestId` → odrzucone jako nieaktualne.
4. Dwa zadania z podobnym tytułem → brak pomieszania; niejednoznaczny prefiks ID → błąd.
5. Osoba bez grantu, forward, edycja, bot, media, wiadomość sprzed `acceptAfter`, wiadomość starsza niż 15 min (z odpowiedzią bota) → żadna nie dociera do zadania.
6. Cofnięcie grantu między pobraniem partii a jej przetworzeniem → odmowa.
7. Restart w każdym punkcie §9.2 (przed claimed, po claimed, po wyniku, przed `getUpdates`) → zgodnie z opisem, bez powtórzeń.
8. Duplikat `update_id`; losowe `update_id` po 7 dniach ciszy.
9. 429 z dużym `retry_after`, 409, wiszący DNS i body, shutdown w trakcie long pollu, odpowiedź >1 MiB.
10. Rotacja i usunięcie tokena, zmiana chat ID, przełączenie na Minimal, wstrzymanie odbiorcy → `suspended` lub `credentials-unavailable`.
11. Dwa projekty z tym samym botem → drugi dostaje 409. Connect chat przy działającym pollerze nie wysyła drugiego `getUpdates`.
12. Uszkodzony plik stanu, read-only home, skopiowany katalog → brak grantów, cockpit działa.
13. Bez `CEZ_CHAT_INBOUND=1`, bez `CEZ_WEBHOOKS=1` albo w trybie hosted: brak pollera i żadnego `getUpdates` inicjowanego przez inbound (dotychczasowy ręczny Connect chat zachowuje własne warunki), mutacje tras zwracają 503 z odpowiednim `code`, `GET /` zwraca `available: false`. Wyłączenie flagi przy zapisanych grantach zatrzymuje odbiór bez kasowania grantów.
14. **Regresje:** istniejące testy tras messages/queued/continue i webhooków przechodzą bez modyfikacji; Slack/Discord/JSON i Telegram tylko wychodzący bez zmian; `CEZ_DRY_RUN=1` bez sieci.
15. Kontrakt: parity schematów i tras, aliasy scoped/unscoped/default, obecność w `AppType`.
16. Audyt: przyjęte/odrzucone/niepewne komendy, opcjonalny runId przy braku dopasowania, agregacja limitów, paginacja, brak treści. UI subskrybuje tylko podczas otwarcia, reconnect odświeża dane, bus nie ujawnia danych parowania.

Dodatkowe obowiązkowe przypadki etapu 1 (A–H):

- **A.** Pierwszy grant: pairing działa bez grantu, bez prawa sterowania; TTL/anulowanie zatrzymuje zbędny poller, dodawanie osoby nie zatrzymuje aktywnych czatów.
- **B.** Przypisanie trwa po shutdown; drugi projekt/proces odmawia; odłączenie i awaria między zapisami; Connect podczas backoffu oraz drugi proces nie wykonują konkurencyjnego getUpdates. Dry-run nie zajmuje locka prawdziwego bota.
- **C.** Awaria przed/po każdym zapisie claimed/wyniku/recovery, błąd fsync/rename, utrata locka, równoczesne revoke i zapis korelacji: brak ponownego skutku i brak utraty cofnięcia grantu.
- **D.** Epoka probing przetrwa restart i puste odpowiedzi; nowe niższe ID po tygodniu działa, stare daty są odrzucone, pusty poll nie przesuwa lastUpdateAt.
- **E.** Stare Reply po capture gap/kompaktowaniu/recovery odrzucone; continuation i episode sprawdzane. Zwykła wypowiedź daje powiadomienie bez treści; status nie wymyśla pytania, /reply pozwala świadomie odpowiedzieć na bieżący waiting.
- **F.** Projekt nieotwarty po restarcie: nieuprawnione wejście nie tworzy kontekstu; uprawnione otwiera tylko własny projekt; recovery/timeout/nieistniejący root kończą się zgodnie z §5.1a.
- **G.** Limit pliku/kolejki/grantów, bardzo długi retry_after, flood od wielu osób: ograniczona pamięć, brak blokowania przetwarzania przez odpowiedzi bota, brak retry polecenia.
- **H.** Jedno powiązanie per bot/chat; jawny projektowy zakres grantu; nowy grant/re-enable nie wykonuje starych wiadomości; awaria zapisu korelacji nie powoduje ponowienia dostawy.

E2E: `packages/web/e2e/telegram-bidirectional.config.ts` wzorowany na `chat-webhooks.config.ts`, z dry-run i wstrzykiwanym transportem Telegrama w istniejącym trybie harness. Bez produkcyjnej trasy do podszywania się pod Telegram.

Komendy (z repo root, z timeoutem):

```sh
timeout 300 npm test -- packages/cezar/src/telegram packages/cezar/src/webhooks packages/cezar/src/server packages/web/src/routes/settings
timeout 300 npm run typecheck
timeout 300 npm run test:unit
timeout 300 npm run build
timeout 600 npm test
timeout 300 ./node_modules/.bin/e2e run --config packages/web/e2e/telegram-bidirectional.config.ts
git diff --check
```

Każdy test regresji dla zmienionego mechanizmu musi być raz pokazany jako czerwony bez poprawki. Porażki pełnego zestawu porównać z bazą przed nazwaniem ich „znanymi”.

**Punkt kontrolny po etapie 1:** scenariusze 1–16 i A–H zautomatyzowane, e2e przechodzi, brak nowych porażek, typecheck i build czyste. Wynik zapisany w notatkach zadania przed rozpoczęciem etapu 2.

### 11.5 Plan i testy etapu 2

Plan:

1. Wydzielenie logiki z handlerów `cancel` i `continue` (czyste przeniesienie, punkt kontrolny, testy tras bez zmian), jak w §6.3.
2. Uprawnienia `cancel` i `continue` w grancie i w UI (domyślnie wyłączone), `PATCH /grants/:id`.
3. `/cancel`, `/continue`, przyciski potwierdzenia (`allowed_updates` rozszerzone o `callback_query`), `answerCallbackQuery`.
4. Grupy: parowanie z kodem porównawczym, Reply i komendy z `@botUsername`, `my_chat_member` (`allowed_updates` rozszerzone o `my_chat_member`), migracja do supergrupy.
5. Dokumentacja i e2e rozszerzone o etap 2.

Scenariusze:

17. Grupa z privacy mode: dwie sparowane osoby z różnymi uprawnieniami; komenda osoby niesparowanej nie ujawnia nowych danych ani nie steruje zadaniem, ale widzi ona publiczne odpowiedzi w grupie; UI wymaga zgody na tę widoczność; komenda do innego bota niczego nie robi.
18. `/cancel` i `/continue` bez uprawnienia albo bez kliknięcia „Potwierdź” nie mają skutku. Podwójne kliknięcie daje jeden skutek. Przycisk kliknięty przez inną osobę, w innym czacie albo po 120 s jest odrzucany.
19. Cofnięcie uprawnienia między podglądem a kliknięciem blokuje akcję.
20. `/continue` przy niedostępnym zapisanym koncie lub stanie niedopuszczającym wznowienia odmawia; brak fallbacku. Blokada nadpisywania modelu nie blokuje sama w sobie zapisanej konfiguracji. Zmiana konta/modelu/stanu po podglądzie unieważnia przycisk.
21. Usunięcie bota z grupy i migracja do supergrupy zawieszają powiązanie bez przenoszenia grantów.
22. Regresje: testy tras `cancel` i `continue` przechodzą bez modyfikacji; scenariusze 1–16 i A–H nadal zielone.

Dodatkowo I–K:

- **I.** Dwa kliknięcia tego samego actionId z różnymi updateId, awaria po claimed i restart — najwyżej jeden skutek; stary/obcy callback otrzymuje odpowiedź, nie akcję.
- **J.** Parowanie prywatne do grupy wiąże konkretny receiver, wymaga porównania kodu; nie nadaje prawa w prywatnym czacie; migracja/service message działa bez pola text.
- **K.** Revoke usuwa oczekujące odpowiedzi z danymi i przyciski; zmiana jednej grupy nie wyłącza innych czatów bota.

**Definition of done całego zadania:** scenariusze 1–22 i A–K zautomatyzowane, e2e obu etapów przechodzi, brak nowych porażek względem bazy, typecheck i build czyste, raport oddziela symulację od opcjonalnego testu na żywym bocie (tylko za osobną zgodą).

## 12. Świadomie odłożone (osobne zgłoszenia)

- **Rezerwacja pytania dla wszystkich zadań** (`expectedAttention` w kontrakcie `messages`/`continue`, atomowe zajęcie pytania w silniku). Naprawia wyścig dwóch odpowiedzi w cockpicie i w Telegramie, ale zmienia zachowanie silnika dla wszystkich zadań. Wymaga objęcia obu ścieżek zakończenia tury w `run.ts` i wszystkich miejsc tworzenia `ActiveRun`.
- **Wspólny limiter per bot** dla dostaw i odpowiedzi bota. Przy obecnym ruchu wystarczy osobny limiter w module (§9.3).
- **Fan-out obserwatora lifecycle.** Niepotrzebny, bo korelacja powstaje w serwisie webhooków.
- **Ujednolicenie `providerCode` i `providerGone`** oraz `providerOptions` w ustawieniach odbiorcy (uwagi z przeglądu outbound).

## 13. Decyzje właściciela (rozstrzygnięte 2026-10-27)

- **D1. Flaga: `CEZ_CHAT_INBOUND=1`.** Osobna zgoda na ruch przychodzący z komunikatorów, domyślnie wyłączona, wymaga `CEZ_WEBHOOKS=1`. Nazwa niezależna od dostawcy, żeby przyszłe dwukierunkowe integracje Slack/Discord używały tej samej flagi. Szczegóły w §2, §11.1, §11.3 i scenariuszu 13.
- **D2. Opóźnienie pytania bez zmian.** `graceSeconds` zostaje z domyślnymi 180 s, UI niczego nie podpowiada. Jeśli opóźnienie okaże się problemem, zmniejszy się wartość domyślną osobną zmianą.
- **D3. Jeden bot na projekt.** Wybór projektu w komendach jest poza zakresem.
- **Język:** spec zostaje po polsku jako dokument wewnętrzny.

## 14. Weryfikacja przy pisaniu specu

Sprawdzono w kodzie: handler `messages` (`server.ts:5007–5060`), `graceSeconds` w `admission.ts:165` i kontrakcie (domyślnie 180), warunek `attention_required` w `lifecycle.ts:6`, zerowanie `attentionRequest` w `store.ts`, pojedynczy `setLifecycleObserver`, brak resolvera skróconych ID, obecność `.agents/skills/e2e/SKILL.md`, `node_modules/.bin/e2e` i `docs/reference.md`. Przy pierwotnym przygotowaniu specu uruchomiono 97 testów istniejących punktów integracji (6 plików, wszystkie zielone). Nie uruchamiano przeglądarki ani żywego bota. Rewizja 5 uwzględnia ponowny przegląd ownership/storage, coordinator/project-context, lifecycle/episodes, handlerów messages/continue oraz renderera. Sprawdzono spójność dokumentu i diff; nie jest to wynik testów przyszłej implementacji.

## 15. Zlecenie wykonania

> Zaimplementuj `.ai/specs/2026-10-27-telegram-bidirectional.md` w jednym zadaniu i na jednej gałęzi, w dwóch etapach: najpierw etap 1 według §11.3, potem punkt kontrolny z §11.4, potem etap 2 według §11.5. Stosuj decyzje z §13. Zasada z §1 jest nadrzędna: zachowanie zadań i odbiorców bez komunikacji dwukierunkowej nie może się zmienić, a istniejące testy tras muszą przechodzić bez modyfikacji. Niczego z §12 nie implementuj. Wykonaj testy z §11.4 i §11.5 i przedstaw dowody, oddzielając symulację od testu na żywo. Nie używaj prawdziwych sekretów i nie wysyłaj prawdziwych wiadomości bez osobnego polecenia. Jeśli baza zmieniła się od wskazanego commita, sprawdź mechanizmy ponownie i zaktualizuj spec.
