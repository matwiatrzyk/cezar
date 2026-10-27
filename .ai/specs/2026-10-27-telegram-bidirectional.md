# Telegram: komunikacja dwukierunkowa z zadaniami cezar

Status: specyfikacja do implementacji, decyzje rozstrzygnięte. 2026-10-27, rewizja 4.
Baza zweryfikowana: `89550186a` na `cez/143115c2`, po obsłudze wysyłek Telegrama i przeniesieniu jego tokenów do sejfu. Spec rozszerza [integrację wychodzącą](2026-10-27-telegram-webhook-receivers.md); nie zmienia jej zasad dostawy, redakcji ani przechowywania sekretów.

## 1. Cel i zasada projektowa

Użytkownik dostaje w Telegramie pytanie albo powiadomienie cezar, odpowiada natywnym „Odpowiedz” i odpowiedź trafia do właściwego zadania. Następne pytania i wyniki wracają przez istniejącą integrację wychodzącą do tego samego czatu.

**Zasada nadrzędna: zmiana dotyka tylko odbiorców Telegrama z włączoną komunikacją dwukierunkową.** Zadania, odbiorcy Slack/Discord/JSON i odbiorcy Telegrama używani tylko do wysyłania zachowują się dokładnie jak dziś. Kod wspólny wolno przenosić, ale nie zmieniać jego zachowania; dowodem są istniejące testy tras, które przechodzą bez modyfikacji. Każde rozwiązanie, które zmienia zachowanie globalne (silnik zadań, wspólny limiter, obserwator lifecycle), jest poza zakresem i trafia do osobnego zgłoszenia (§12).

## 2. Etapy

Etapy to kolejne części pracy w ramach jednego zadania i jednej gałęzi, nie osobne PR-y. Między etapami jest punkt kontrolny: etap 2 zaczyna się dopiero, gdy wszystkie testy etapu 1 (§11.4) przechodzą, a ich wynik jest zapisany w notatkach zadania. Etap 1 jest sam w sobie użyteczny, więc gdyby prace trzeba było przerwać, gałąź po etapie 1 jest spójnym stanem.

**Schematy projektujemy od razu pod oba etapy:** grant ma pole `permissions` już w etapie 1 (z jedną wartością `respond`), a plik stanu ma jeden `schemaVersion: 1`. Etap 2 nie migruje danych z etapu 1.

**Etap 1 (MVP), czat prywatny:**
- jedna osoba, jej własny czat prywatny z botem;
- natywne Reply na pytanie albo powiadomienie o zadaniu, które czeka na użytkownika;
- komendy `/help`, `/tasks`, `/status <task>`, `/reply <task> <tekst>`;
- działanie, gdy serwer cezar jest uruchomiony, również po zamknięciu przeglądarki;
- bezpieczne zachowanie przy restarcie, utracie sieci, cofnięciu dostępu i rotacji tokena.

**Etap 2:**
- zwykłe grupy i supergrupy bez tematów forum, wiele sparowanych osób w czacie;
- `/cancel <task>` i `/continue <task> [tekst]` z potwierdzeniem przyciskiem.

**Włączenie funkcji:** nowa zmienna `CEZ_CHAT_INBOUND=1`, domyślnie wyłączona, wymagająca także `CEZ_WEBHOOKS=1` (decyzja D1). Nazwa jest niezależna od dostawcy: ta sama flaga obejmie przyszłe dwukierunkowe integracje ze Slackiem, Discordem itp. Bez niej moduł nie uruchamia pollera, trasy z §11.1 odmawiają mutacji (503, `code: 'flag_off'`), a UI pokazuje sekcję z informacją, jak funkcję włączyć. Sama flaga niczego nie paruje ani nie uruchamia; nadal potrzebne jest jawne włączenie w UI i zatwierdzony grant.

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

### 5.1 Jeden poller na bota

`TelegramInbound` (moduł w `packages/cezar/src/telegram/`) jest uruchamiany przez serwis webhooków projektu, gdy działa `CEZ_CHAT_INBOUND=1` i projekt ma co najmniej jednego odbiorcę Telegrama z włączoną komunikacją dwukierunkową. Nie jest osobnym demonem i nie startuje RunManagerów innych projektów.

- Na bota (`botId` z `getMe`, nie username ani token) działa najwyżej jedno żądanie `getUpdates`.
- Bot może mieć jeden projekt właściciela komunikacji dwukierunkowej w danym `CEZ_HOME` (decyzja D3). Dokumentacja mówi wprost: kilka projektów z odpowiedziami w Telegramie = kilka botów. Wyłączność zapewnia lock `cezarHomeDir()/telegram/bots/<botId>.lock` na mechanizmie z `webhooks/ownership.ts`, użytym bez zmian. Inny projekt dalej może wysyłać przez tego bota; próba włączenia odbioru dostaje 409 z nazwą projektu właściciela.
- Serwer w trybie hosted nie uruchamia pollera nawet z flagą; `GET /` zwraca `available: false`, powód `hosted`.
- 409 od Telegrama oznacza inną aplikację lub inny `CEZ_HOME`: stan `conflict`, poller staje, bez automatycznego przejmowania.

### 5.2 Long polling

- `getUpdates` z `timeout=25`, deadline całego żądania 35 s (DNS, body, shutdown), `limit=50`, `allowed_updates=["message"]` w etapie 1 (`callback_query` dochodzi w etapie 2). Włączenie odbioru jest zgodą na zmianę `allowed_updates` dedykowanego bota.
- Reużyć istniejącą politykę transportu: przypięty DNS, brak redirectów, stały host, limit body 1 MiB. Timeout long pollingu jest osobnym parametrem wywołania; globalny timeout webhooków się nie zmienia.
- Body >1 MiB: ponowić ten sam offset z `limit=1`; jeśli dalej za duże, stan `blocked`, bez potwierdzania danych.
- Sieć/5xx: backoff z jitterem 1–60 s. 429: czekać co najmniej `retry_after`. 401 lub niezgodny fingerprint sekretu: `credentials-unavailable`. Inne 4xx: stała diagnostyka i zatrzymanie.

### 5.3 „Connect chat” przy działającym odbiorze

Gdy poller działa dla danego bota, `POST /webhooks/telegram/connect` dla tego bota nie wykonuje własnego `getUpdates` (dostałby 409). Zamiast tego rejestruje kod w pamięci pollera, a poller przekazuje mu dopasowany czat. Gdy poller nie działa, Connect chat zostaje bez zmian. Kontrakt trasy się nie zmienia.

## 6. Rozmowa

### 6.1 Co poller przyjmuje

Tylko `message` z polem `text` w czacie prywatnym, `from.is_bot === false`, bez `forward_origin`, `via_bot`, `sender_chat`, edycji i mediów. Reszta jest potwierdzana offsetem i ignorowana. Wiadomość od osoby bez aktywnego grantu dostaje wyłącznie ogólną instrukcję parowania, najwyżej raz na minutę na czat, bez żadnych danych projektu.

**Wiadomości przeterminowane:** polecenie starsze niż 15 minut (pole `date`) albo sprzed włączenia odbioru (`acceptAfter`) nie jest wykonywane. Bot odpisuje: „Wiadomość z HH:MM dotarła po N min, gdy cezar był niedostępny. Nie przekazano jej. Sprawdź stan: /status <task>”. Przy wielu takich wiadomościach z jednej partii wysyła jedną zbiorczą odpowiedź.

### 6.2 Natywne Reply

Odpowiedź rozpoznajemy po `(botId, chatId, reply_to_message.message_id)` w trwałej korelacji z dostawy (§7). Nie ufamy cytowanemu tekstowi ani tytułowi zadania.

Korelacja przechowuje: `receiverId`, `deliveryRevision`, `runId`, typ zdarzenia, `sequence` zdarzenia lifecycle oraz, jeśli było, `requestId` i `askedAt`.

**Aktualność** sprawdzamy w adapterze tuż przed przekazaniem wiadomości:
- zadanie nadal ma status `waiting`;
- od skorelowanego zdarzenia nie było nowszego zdarzenia lifecycle tego zadania (porównanie `sequence`; jeśli serwis webhooków nie udostępnia bieżącej sekwencji zadania, dodać odczyt w serwisie, nie nowe pole `RunRecord`);
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

Wydzielić z handlera `POST /runs/:id/messages` funkcję (np. `deliverUserMessage` w `packages/cezar/src/server/run-messages.ts`) zawierającą obecną logikę: kontrolę dostawcy i konta, limity kolejki oraz drabinę send → enqueue → defer → odmowa. Handler HTTP woła tę funkcję; idempotencja HTTP i kształty odpowiedzi zostają w handlerze. **To czyste przeniesienie kodu:** `queued-messages.test.ts`, `message-receipts.test.ts` i pozostałe testy tras przechodzą bez zmian.

Adapter Telegrama woła tę samą funkcję. Nie wolno wołać `manager.sendMessage` bezpośrednio, `deliverMessage` z `run.ts` ani trasy HTTP (także przez `app.request`).

Tekst trafia do agenta z prefiksem `[via Telegram] `, bez nazwy użytkownika (nazwa jest niezaufanym wejściem). Prefiks jest też widoczny w wątku zadania w cockpicie.

Odpowiedź bota odzwierciedla wynik funkcji: „Przekazano”, „Dodano do kolejki”, „Czeka na start sesji” albo „Odrzucono: <stały powód>”. Żadna nie oznacza, że agent wykonał polecenie.

### 6.4 Komendy

Parser zamkniętego słownika. Tekst do 4000 znaków.

| Komenda | Etap | Zachowanie |
| --- | --- | --- |
| `/help` | 1 | lista dostępnych komend |
| `/tasks` | 1 | do 10 najnowszych niearchiwalnych zadań projektu: krótkie ID, status, tytuł |
| `/status <task>` | 1 | status i metadane jak w powiadomieniu Standard; dla `waiting` także treść pytania. Formatowanie, escapowanie HTML i limit 4096 znaków przez istniejący renderer z `webhooks/telegram.ts` |
| `/reply <task> <tekst>` | 1 | jak Reply, ale bez korelacji; dla czekającego zadania odpowiada na bieżące pytanie |
| `/cancel <task>` | 2 | podgląd + przycisk „Potwierdź”, ważny 120 s |
| `/continue <task> [tekst]` | 2 | podgląd z dostawcą/kontem i ostrzeżeniem o koszcie + przycisk, ważny 120 s |

**Skrócone ID (nowe):** pełny UUID albo prefiks co najmniej 8 znaków pasujący do dokładnie jednego niearchiwalnego zadania projektu. Brak lub kilka dopasowań → błąd z prośbą o dłuższy prefiks. Resolver jest zwykłą funkcją w module Telegrama.

## 7. Korelacja wysyłki

W `transport.ts` dla formatu `telegram.v1` sparsować z udanej odpowiedzi wyłącznie `result.message_id` i `result.chat.id`; resztę body odrzucić jak dziś. Serwis webhooków, gdy dostawa jest `delivered` i odbiorca ma włączoną komunikację dwukierunkową, zapisuje korelację (§6.2) w stanie modułu Telegrama. Korelacja powstaje w serwisie przy domknięciu dostawy, więc obserwator lifecycle zostaje bez zmian. Brak `message_id` oznacza brak korelacji, a nie błąd dostawy. Korelacje żyją 7 dni, najwyżej 5000 na bota (najstarsze odpadają).

Zmiana chat ID, formatu, tokena albo `deliveryRevision` unieważnia stare korelacje.

## 8. Parowanie i uprawnienia

### 8.1 Przepływ (etap 1)

1. W szczegółach aktywnego, przetestowanego odbiorcy Telegrama (profil Standard, subskrypcja `task.attention_required`) użytkownik klika „Enable two-way”. UI wyjaśnia, że odpowiedzi sterują agentem i mogą prowadzić do zmian w kodzie i kosztów, oraz wymaga potwierdzenia, że bot jest dedykowany.
2. Serwer generuje kod: 24 losowe bajty base64url, ważny 5 minut, trzymany tylko w pamięci jako hash. Maks. 3 kody na projekt. Restart unieważnia niedokończone parowanie.
3. Użytkownik otwiera `t.me/<bot>?start=<kod>` i naciska Start. Poller wymaga czatu prywatnego, `from.is_bot === false` i `chat.id === receiver.telegramChatId`.
4. Cockpit pokazuje kandydata: numeryczne ID, nazwę i username (jako etykiety nieautorytatywne). Użytkownik klika „Zatwierdź”. Kod porównawczy nie jest potrzebny, bo czat prywatny został wcześniej potwierdzony testem dostawy, a ID kandydata musi być równe chat ID.
5. Grant `(project, botId, chatId, userId)` jest zapisany; bot wysyła potwierdzenie.

Grant nie przechodzi na innego bota ani inny czat. Rotacja tokena tego samego bota zawiesza odbiór do udanego testu i ponownego włączenia; granty zostają.

### 8.2 Uprawnienia

Etap 1 ma jeden poziom: **`respond`**, czyli `/tasks`, `/status`, Reply i `/reply`. Etap 2 dodaje `cancel` i `continue`, domyślnie wyłączone, oraz parowanie w grupach (§10).

Uprawnienia nadaje i cofa wyłącznie cockpit. Sprawdzamy je przy każdej wiadomości, tuż przed skutkiem. Cofnięcie działa natychmiast, także dla już pobranej partii.

Odbiorca przełączony na Minimal, odsubskrybowany z `attention_required`, wstrzymany albo wyłączony automatycznie zawiesza odbiór. Nie wprowadzamy częściowych uprawnień zależnych od profilu.

## 9. Stan, trwałość i bezpieczeństwo

### 9.1 Plik stanu

`.ai/cezar/webhooks/telegram/<botId>.json` (w dry-run pod istniejącą ścieżką dry-run), schemat Zod z `schemaVersion: 1`, zapis atomowy tmp/fsync/rename, katalog 0700, pliki 0600, jak pozostały wrażliwy stan webhooków. Zawartość: granty, `acceptAfter`, `nextOffset`, `lastUpdateAt`, korelacje i dziennik akcji. Bez tokena, bez treści wiadomości. Limit pliku 2 MiB; po przekroczeniu najpierw odpadają najstarsze korelacje.

Brak lub uszkodzenie pliku oznacza brak grantów i stan wyłączony, nigdy „wszystko dozwolone”. Uszkodzonego pliku nie nadpisujemy pustym. Plik wiąże się z project identity i kanonicznym rootem; skopiowany do innego repozytorium jest nieaktywny.

### 9.2 Przetwarzanie partii i awarie

Partia jest przetwarzana sekwencyjnie, aktualizacja po aktualizacji:

1. `update_id < nextOffset` → pominąć (duplikat).
2. Autoryzacja, filtr świeżości, parser.
3. Dla akcji zmieniającej zadanie: zapisać w dzienniku `{updateId, runId, state: 'claimed'}` → wywołać `deliverUserMessage` → zapisać wynik i `nextOffset = updateId + 1` w jednym zapisie.
4. Dla odczytu i odrzuceń: wystarczy zapisać `nextOffset`.

Kolejne `getUpdates` potwierdza w Telegramie tylko to, co jest już zapisane. Po restarcie wpis `claimed` bez wyniku oznacza wynik niepewny: akcja nie jest powtarzana, a bot wysyła „Nie wiem, czy wiadomość dotarła do zadania <id>. Sprawdź: /status <id>”. Gwarancja: najwyżej jedna automatyczna próba na aktualizację. Exactly-once nie jest obiecywane. Dziennik trzyma 500 ostatnich wpisów bez treści. Każdy wpis ma: czas, `telegramUserId`, `runId`, rodzaj akcji (`reply`, `answer`, w etapie 2 `cancel`, `continue`) i wynik. Służy też jako widoczny w UI dziennik aktywności (§11.2).

Nie ma trwałej kolejki oczekujących akcji ani trwałej kolejki odpowiedzi bota. Odpowiedzi bota są wysyłane od razu, z 3 próbami w pamięci. Po awarii mogą przepaść, a stan zadania zostaje widoczny w cockpicie i przez `/status`.

**Epoka:** jeśli `lastUpdateAt` jest starsze niż 6 dni, pierwsze żądanie idzie bez offsetu (numeracja mogła się zresetować). `acceptAfter` i filtr 15 minut chronią przed wykonaniem starych poleceń.

### 9.3 Limity i wysyłka odpowiedzi

Odpowiedzi bota idą bezpośrednio przez `sendMessage` z istniejącą polityką transportu, z prostym limiterem w module: 1 wiadomość/s na czat, cooldown po 429. **Istniejący limiter i kolejka dostaw webhooków pozostają bez zmian.** Wejście: do 20 akcji/min na użytkownika; nadmiar dostaje „Za dużo wiadomości, spróbuj za chwilę”.

### 9.4 Prywatność

Nie logujemy surowych aktualizacji, kodów parowania ani tokena. Treść odpowiedzi trafia wyłącznie do zadania, jak wiadomość z cockpitu. Telemetria nie dostaje ID użytkownika ani czatu, tekstów ani nazw. Linki do zadań idą zgodnie z obecną polityką linków (tylko hosted).

### 9.5 Stany odbioru

| Stan | Wejście | Wyjście |
| --- | --- | --- |
| `disabled` | domyślny; wyłączenie przez użytkownika | „Enable two-way” po spełnieniu warunków |
| `pairing` | wygenerowany kod | zatwierdzenie → `active`; wygaśnięcie → `disabled` |
| `active` | grant, lock, sekret, aktywny odbiorca | każda przyczyna niżej |
| `backoff` | sieć, 5xx, 429 | timer |
| `suspended` | odbiorca paused/disabled/Minimal, zmiana chat ID, bot usunięty z czatu | naprawa i ponowne włączenie w UI |
| `credentials-unavailable` | 401, brak lub zmiana sekretu | nowy token, test, ponowne włączenie |
| `conflict` | 409 Telegrama, lock innego projektu | usunięcie konfliktu i ponowne włączenie |
| `blocked` | odpowiedź za duża, niekompatybilny stan | naprawa i ponowne włączenie |
| `stopped` | zamknięcie serwera | start serwera, jeśli zapisano włączenie i są granty |

Shutdown: przerwać long poll i timery, maks. 5 s na domknięcie zapisów, zwolnić lock. Boot nie czeka na sieć.

## 10. Etap 2: grupy, `/cancel`, `/continue`

- **Grupy:** parowanie każdej osoby nadal w czacie prywatnym; zatwierdzając, cockpit wskazuje grupę, w której ta osoba może sterować. W grupie przyjmujemy tylko Reply na wiadomość bota i komendy z `@botUsername`. Nie autoryzujemy adminów ani wszystkich członków. Tu przywrócić kod porównawczy pokazywany w bocie i w cockpicie, bo ID kandydata nie da się sprawdzić z chat ID. Migracja grupy do supergrupy i usunięcie bota (`my_chat_member`) zawieszają powiązanie.
- **`/cancel` i `/continue`:** wydzielić logikę z handlerów `cancel` i `continue` tak samo jak w §6.3 (czyste przeniesienie, testy tras bez zmian). Potwierdzenie przyciskiem: `callback_data` to losowe ID akcji trzymane w pamięci przez 120 s, sprawdzane względem autora, czatu i stanu zadania; podwójne kliknięcie daje jeden skutek. `/continue` używa zapisanego dostawcy i konta, bez fallbacku.

## 11. Kontrakt HTTP, UI, plan i testy

### 11.1 Trasy

Rodzina tras projektu w łańcuchu, pod `/api/v1/telegram` i `/api/v1/p/:projectId/telegram`. Schematy najpierw w `packages/contract`, walidacja przez trio z `validators.ts`, wpis w `BACKWARD_COMPATIBILITY.md` §2.

| Trasa | Request | Response |
| --- | --- | --- |
| `GET /` | — | dostępność, stan odbioru per odbiorca, granty, `revision` |
| `POST /pairings` | `receiverId`, `expectedRevision`, `dedicatedBot: true` | `pairingId`, `expiresAt`, `deepLink` |
| `GET /pairings/:id` | — | `waiting` / `candidate` (z danymi kandydata) / `confirmed` / `expired` |
| `POST /pairings/:id/confirm` | `expectedRevision`, `candidateUserId` | grant, `revision` |
| `DELETE /pairings/:id` | — | `{ cancelled: true }` |
| `PATCH /receivers/:id` | `expectedRevision`, `enabled` | stan, `revision`; `enabled: true` ponownie sprawdza wszystkie warunki |
| `DELETE /grants/:id` | `expectedRevision` w query | `{ revoked: true }`, `revision` |

Błędy: `{ error, code }`; 400, 404, 409 (rewizja, właściciel bota, stan), 429 z `Retry-After`, 503 (brak sekretu, `flag_off`, `webhooks_off`, `hosted`). `GET /` działa także przy wyłączonej fladze i zwraca `available: false` z powodem, żeby UI mogło wyjaśnić, jak włączyć funkcję. Grant ma `permissions` od etapu 1. Etap 2 dodaje `permissions` do `POST /pairings/:id/confirm` (w etapie 1 zawsze `['respond']`) oraz `PATCH /grants/:id` (`expectedRevision`, `permissions`), który podnosi generację grantu i unieważnia oczekujące potwierdzenia.

### 11.2 UI

Sekcja „Two-way communication” w szczegółach odbiorcy Telegrama: warunki (Standard, `attention_required`), przycisk włączenia z opisem skutków, link parowania, kandydat do zatwierdzenia, lista osób z „Revoke”, stan odbioru z czasem ostatniego udanego pollu i opisem błędu. Status parowania sprawdzany zapytaniem co 3 s tylko przy otwartym dialogu, jak dziś Connect chat. Region `aria-live` tylko dla linii stanu. Etykieta „Connected” dopiero po zatwierdzeniu.

**Dziennik aktywności:** lista ostatnich akcji z Telegrama (czas, osoba jako etykieta + numeryczne ID, zadanie, akcja, wynik), bez treści wiadomości. Pozwala sprawdzić, kto i kiedy sterował zadaniem. Wyniki niepewne (§9.2) są wyróżnione.

**Wątek zadania:** wiadomość z prefiksem `[via Telegram]` jest zwykłą wiadomością użytkownika; nie dodajemy nowego typu zdarzenia.

### 11.3 Plan etapu 1

1. Wydzielenie `deliverUserMessage` (§6.3). Ten krok to osobny commit i warunek następnych: wszystkie testy tras przechodzą bez zmian.
2. Plik stanu, lock bota, dziennik akcji, z testami awarii.
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
13. Bez `CEZ_CHAT_INBOUND=1`, bez `CEZ_WEBHOOKS=1` albo w trybie hosted: brak pollera i żadnego `getUpdates`, mutacje tras zwracają 503 z odpowiednim `code`, `GET /` zwraca `available: false`. Wyłączenie flagi przy zapisanych grantach zatrzymuje odbiór bez kasowania grantów.
14. **Regresje:** istniejące testy tras messages/queued/continue i webhooków przechodzą bez modyfikacji; Slack/Discord/JSON i Telegram tylko wychodzący bez zmian; `CEZ_DRY_RUN=1` bez sieci.
15. Kontrakt: parity schematów i tras, aliasy scoped/unscoped/default, obecność w `AppType`.
16. Dziennik aktywności: każda akcja (przyjęta, odrzucona, niepewna) ma wpis z osobą i zadaniem, bez treści.

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

**Punkt kontrolny po etapie 1:** scenariusze 1–16 zautomatyzowane, e2e przechodzi, brak nowych porażek, typecheck i build czyste. Wynik zapisany w notatkach zadania przed rozpoczęciem etapu 2.

### 11.5 Plan i testy etapu 2

Plan:
1. Wydzielenie logiki z handlerów `cancel` i `continue` (czyste przeniesienie, osobny commit, testy tras bez zmian), jak w §6.3.
2. Uprawnienia `cancel` i `continue` w grancie i w UI (domyślnie wyłączone), `PATCH /grants/:id`.
3. `/cancel`, `/continue`, przyciski potwierdzenia (`allowed_updates` rozszerzone o `callback_query`), `answerCallbackQuery`.
4. Grupy: parowanie z kodem porównawczym, Reply i komendy z `@botUsername`, `my_chat_member` (`allowed_updates` rozszerzone o `my_chat_member`), migracja do supergrupy.
5. Dokumentacja i e2e rozszerzone o etap 2.

Scenariusze:
17. Grupa z privacy mode: dwie sparowane osoby z różnymi uprawnieniami; osoba niesparowana nie dostaje żadnych danych zadania; komenda do innego bota niczego nie robi.
18. `/cancel` i `/continue` bez uprawnienia albo bez kliknięcia „Potwierdź” nie mają skutku. Podwójne kliknięcie daje jeden skutek. Przycisk kliknięty przez inną osobę, w innym czacie albo po 120 s jest odrzucany.
19. Cofnięcie uprawnienia między podglądem a kliknięciem blokuje akcję.
20. `/continue` przy niedostępnym koncie, zablokowanym modelu albo aktywnej sesji zachowuje dzisiejsze odmowy; brak fallbacku dostawcy.
21. Usunięcie bota z grupy i migracja do supergrupy zawieszają powiązanie bez przenoszenia grantów.
22. Regresje: testy tras `cancel` i `continue` przechodzą bez modyfikacji; scenariusze 1–16 nadal zielone.

**Definition of done całego zadania:** scenariusze 1–22 zautomatyzowane, e2e obu etapów przechodzi, brak nowych porażek względem bazy, typecheck i build czyste, raport oddziela symulację od opcjonalnego testu na żywym bocie (tylko za osobną zgodą).

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

Sprawdzono w kodzie: handler `messages` (`server.ts:5007–5060`), `graceSeconds` w `admission.ts:165` i kontrakcie (domyślnie 180), warunek `attention_required` w `lifecycle.ts:6`, zerowanie `attentionRequest` w `store.ts`, pojedynczy `setLifecycleObserver`, brak resolvera skróconych ID, obecność `.agents/skills/e2e/SKILL.md`, `node_modules/.bin/e2e` i `docs/reference.md`. Poprzednia rewizja uruchomiła 97 testów istniejących punktów integracji (6 plików, wszystkie zielone). Nie uruchamiano przeglądarki ani żywego bota.

## 15. Zlecenie wykonania

> Zaimplementuj `.ai/specs/2026-10-27-telegram-bidirectional.md` w jednym zadaniu i na jednej gałęzi, w dwóch etapach: najpierw etap 1 według §11.3, potem punkt kontrolny z §11.4, potem etap 2 według §11.5. Stosuj decyzje z §13. Zasada z §1 jest nadrzędna: zachowanie zadań i odbiorców bez komunikacji dwukierunkowej nie może się zmienić, a istniejące testy tras muszą przechodzić bez modyfikacji. Niczego z §12 nie implementuj. Wykonaj testy z §11.4 i §11.5 i przedstaw dowody, oddzielając symulację od testu na żywo. Nie używaj prawdziwych sekretów i nie wysyłaj prawdziwych wiadomości bez osobnego polecenia. Jeśli baza zmieniła się od wskazanego commita, sprawdź mechanizmy ponownie i zaktualizuj spec.
