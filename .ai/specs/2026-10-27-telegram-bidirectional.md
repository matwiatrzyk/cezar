# Telegram: komunikacja dwukierunkowa z zadaniami cezar

Status: specyfikacja do implementacji, bez implementacji w tym dokumencie. 2026-10-27.
Baza zweryfikowana: `d34b3db26` na `cez/143115c2`, po obsłudze wysyłek Telegrama i przeniesieniu jego tokenów do sejfu. Spec rozszerza [integrację wychodzącą](2026-10-27-telegram-webhook-receivers.md); nie zastępuje jej zasad dostawy, redakcji ani przechowywania sekretów.

## 1. Cel i ustalony zakres

Użytkownik dostaje w Telegramie powiadomienie lub pytanie cezar, używa natywnego „Odpowiedz” i jego odpowiedź trafia do właściwego zadania. Cezar potwierdza przyjęcie, a następne pytania i wyniki wracają przez istniejącą integrację do tego samego czatu. To jeden kanał komunikacji dwukierunkowej. „Connect chat”, parowanie użytkownika i rozmowa korzystają ze wspólnego odbioru aktualizacji; nie uruchamiają konkurujących konsumentów `getUpdates`.

V1 obejmuje:

- istniejące zadania jednego projektu: status, listę zadań, wiadomości do aktywnego zadania, odpowiedzi na pytania, jawne anulowanie i wznowienie;
- czaty prywatne, zwykłe grupy i supergrupy bez tematów forum;
- wielu zatwierdzonych użytkowników i wiele powiązanych czatów w projekcie;
- działanie, gdy lokalny serwer cezar jest uruchomiony, również po zamknięciu przeglądarki;
- restart, utratę sieci, cofnięcie uprawnień, rotację tokena, współbieżność z cockpitowym UI i bezpieczne zachowanie po awarii.

Poza V1: tworzenie nowych zadań, wybór modelu/konta/workflow przez Telegram, załączniki i głos, terminal, polecenia shell, merge/push/land, autoryzowanie narzędzi dostawcy, odbiór przez publiczny webhook HTTPS, hosted cockpit, forum topics, interaktywne kanały Telegrama i pełny streaming transkryptu. Kanały zachowują dotychczasowy outbound. Nie wprowadzamy ogólnego `/approve`: odpowiedź na pytanie agenta, akceptacja narzędzia dostawcy i scalenie kodu to różne operacje.

Domyślnie nowa funkcja jest wyłączona. Implementacja doda `CEZ_TELEGRAM_INBOUND=1`, wymagające także istniejącego `CEZ_WEBHOOKS=1`, lokalnego trybu serwera, jawnego włączenia dla odbiorcy i zatwierdzonego uprawnienia użytkownika. Flaga sama niczego nie paruje ani nie uruchamia zadań. Nie zmieniamy zachowania Slacka, Discorda ani odbiorców Telegrama używanych tylko do wysyłania. Nowa flaga musi trafić do `.env.example` i `docs/reference.md`.

## 2. Fakty zweryfikowane w obecnym kodzie

Ścieżki poniżej są względne wobec korzenia repozytorium. To miejsca integracji, nie zalecenie kopiowania ich implementacji.

| Miejsce | Obecne zachowanie i konsekwencja |
| --- | --- |
| `packages/cezar/src/webhooks/telegram-secrets.ts` | Token jest w projektowym `SecretStore`, audience wyłącznie `cezar`; referencja zawiera fingerprint. Korzystać z tego mechanizmu, bez nowego magazynu tokenów i bez fallbacku do workspace/env. |
| `packages/cezar/src/webhooks/telegram-connect.ts` | Każde wywołanie robi `getMe` i niekonsumujące `getUpdates`, bez offsetu. To wykrywanie czatu, NIE autoryzacja człowieka. |
| `packages/cezar/src/webhooks/transport.ts` | Udana odpowiedź Telegrama jest odrzucana, więc nie zachowujemy `message_id`. Natywna odpowiedź wymaga nowego, minimalnego potwierdzenia dostawy. |
| `packages/cezar/src/webhooks/service.ts` | Zarządza claim/complete dostaw, testami i konfiguracją. Należy zachować kontrolę rewizji i wszystkie obecne zabezpieczenia. |
| `packages/cezar/src/webhooks/coordinator.ts` | Odkrywa projekty i zarządza usługami bez konieczności uruchamiania każdego RunManagera. Zachować tę własność. |
| `packages/cezar/src/webhooks/ownership.ts` | Istnieje lease z identyfikacją procesu i ostrożnym odzyskiwaniem. Lease projektu nie zapewnia wyłączności bota użytego w dwóch projektach. |
| `packages/cezar/src/server/server.ts` | Trasy messages/continue/cancel mają różne warunki. Messages ma kolejność send → enqueue → defer; continue dodatkowo sprawdza dostawcę, konto i możliwość wznowienia. |
| `packages/cezar/src/server/message-receipts.ts` | Idempotencja HTTP jest w pamięci, z TTL i limitem. Nie zapewnia deduplikacji po restarcie. |
| `packages/cezar/src/workflows/run.ts` | `sendMessage` prowadzi do prywatnego `deliverMessage`; wiadomość użytkownika może odblokować pytanie/Guard. Przyjęcie nie zawsze oznacza natychmiastowe wysłanie do procesu agenta. |
| `packages/cezar/src/runs/store.ts` | `setLifecycleObserver` ma pojedynczego odbiorcę. Nie wolno nadpisać obserwatora webhooków drugim obserwatorem Telegrama. |
| `packages/web/src/routes/task-thread/ask-answer.ts` | UI rozróżnia żywą sesję i wznowienie, weryfikuje dostawcę i obsługuje zamykanie starej sesji. Telegram nie może omijać tych zasad. |
| `packages/web/src/routes/task-thread/ask-selections.ts` | Identyfikator pytania może być użyty ponownie po Continue. Sam `requestId` nie identyfikuje bezpiecznie pytania. |
| `packages/contract/src/webhooks.ts`, `packages/cezar/src/core/ask.ts` | Projekcja pytania dla webhooków nie zachowuje wszystkich danych, m.in. `multiSelect`. V1 używa odpowiedzi tekstowych, nie zgaduje semantyki przycisków odpowiedzi. |

Przed zmianą współdzielonych obiektów wykonawca musi znaleźć wszystkie miejsca ich konstrukcji i oba przepływy zakończenia tury w `workflows/run.ts`. Nie wolno naprawić tylko ścieżki uruchamiania nowych zadań, pozostawiając Continue/recovery bez danych.

## 3. Zweryfikowane ograniczenia Telegrama

`getUpdates` i webhook są rozłączne. Aktualizacje czekają najwyżej 24 godziny. Offset potwierdza wcześniejsze aktualizacje, a po długiej bezczynności numeracja może zacząć się od losowego ID. `allowed_updates` jest zapamiętywane i nie filtruje już oczekujących aktualizacji. Bot API zwraca wiadomość po `sendMessage`; identyfikatory użytkownika/czatu należy zachować bez utraty precyzji. [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)

Deep link `/start` ma ograniczony alfabet i długość do 64 znaków. W grupie tryb prywatności pozwala otrzymywać skierowane do bota komendy i odpowiedzi na jego wiadomości. Nie trzeba wyłączać privacy mode. Zakresy menu komend nie są autoryzacją. [Telegram bot features](https://core.telegram.org/bots/features#deep-linking)

Nie można uznać „bot działa bez webhooka” za dowód, że inna aplikacja go nie odpytuje. Wymagamy dedykowanego bota i ostrzegamy przed współdzieleniem; konflikt 409 zatrzymuje odbiór. Nigdy automatycznie nie wywołujemy `deleteWebhook`, `setWebhook`, ujemnego offsetu ani usuwania kolejki. [Telegram FAQ](https://core.telegram.org/bots/faq#getting-updates)

Pozostałe wartości liczbowe w tej specyfikacji są limitami produktu, nie twierdzeniami o limitach Telegrama. Nie dodawać zależności od najnowszych, niepotrzebnych funkcji Bot API.

## 4. Model własności i wspólny odbiornik

### 4.1 Jedna sesja odbioru na bota

Nowy `TelegramCoordinator` jest zarządzany przez serwer i utrzymuje mapę po zweryfikowanym `botId` z `getMe`, nie po username ani tokenie. Bot może mieć jednego właściciela projektu dla inbound w danym `CEZ_HOME`. Wiele odbiorców/czatów tego projektu współdzieli odbiornik. Ten sam bot w innych projektach może nadal wysyłać wiadomości, ale drugi projekt nie może włączyć inbound. Konflikt wskazuje projekt właściciela lokalnie; Telegram nie dostaje informacji o innych projektach.

Dla pary `(botId, chatId)` może istnieć najwyżej jedno aktywne powiązanie inbound. Powiązanie wskazuje konkretny receiver i jego rewizję. Nie wybieramy odbiorcy na podstawie nazwy, ostatniej aktywności ani kolejności w tablicy. Chat ID musi być kanonicznym liczbowym ID potwierdzonym przez Telegram; `@username` nadal działa outbound, lecz inbound wymaga przypisania stabilnego ID w procesie konfiguracji i ponownego testu zmienionego odbiorcy.

Cross-process lease jest pod `cezarHomeDir()/telegram/bots/<botId>/`; wykorzystać lub wydzielić mechanizm z `webhooks/ownership.ts`. Musi zachować ochronę przed PID reuse i przejęciem na podstawie samego wieku. Nazwa katalogu pochodzi wyłącznie ze zwalidowanego ID. Lease obejmuje także chwilowe odkrywanie czatu. Nie obiecujemy wyłączności między różnymi `CEZ_HOME` ani maszynami; chronią przed tym dedykowany bot i zatrzymanie przy konflikcie.

### 4.2 „Connect chat” należy do tego samego przepływu

- Kiedy inbound działa, Connect chat rejestruje krótkotrwałe oczekiwanie na kod we wspólnym brokerze. Nie wykonuje własnego `getUpdates`. Poller przekazuje dopasowane metadane czatu do brokera i zapisuje aktualizację przed przesunięciem offsetu.
- Kiedy inbound nie działa, zachować obecne krótkie, niekonsumujące wykrywanie czatu pod tym samym lease. Ograniczenie pierwszych 100 aktualizacji i ostrzeżenie pozostają prawdziwe. Dopiero jawne uruchomienie parowania/inbound daje zgodę na konsumowanie aktualizacji dedykowanego bota.
- Przejście discovery → pairing → active jest koordynowane: anuluj i doczekaj zakończenia poprzedniego requestu, potem rozpocznij nowy. Nigdy dwa `getUpdates` naraz.
- Discovery i autoryzacja człowieka mają różne typy challenge. Zwykłe Connect chat nie nadaje żadnych uprawnień.
- `getMe` wykonujemy przy otwarciu sesji/zmianie credential generation; wynik w pamięci do 10 minut. Nie przy każdym pollu. Weryfikacja sekretu i uprawnień nie jest objęta takim cache.
- Żaden widok przeglądarki nie jest właścicielem aktywnego odbiornika. Zamknięcie formularza usuwa tylko jego discovery challenge; nie zatrzymuje działającej komunikacji.

## 5. Konfiguracja, parowanie i uprawnienia

### 5.1 Przepływ w cockpicie

W szczegółach odbiorcy Telegram: sekcja „Two-way communication”. Pokazuje wymagane flagi, stan odbioru i listę zatwierdzonych osób. Dostępna po udanym teście i aktywacji odbiorcy. Publiczny kanał lub forum dostaje wyjaśnienie ograniczenia, bez przycisku, który zawsze kończy się błędem. Włączenie pełnej rozmowy wymaga profilu Standard i subskrypcji `task.attention_required`; UI pokazuje te warunki i pozwala je jawnie zmienić, nie rozszerza eksportowanych treści w tle. Minimal może mieć jedynie `read` i `cancel`; uprawnienia `reply`, `answer` i `continue` wymagają Standard. Zmiana profilu/subskrypcji podczas działania natychmiast zawiesza niezgodne uprawnienia. Nie deklarować pełnej rozmowy, gdy konfiguracja celowo wycina pytania.

Zakres zadań jest projektem, nie tylko listą dotychczas wysłanych powiadomień. Przy nadawaniu grantów UI jawnie informuje, że osoba będzie mogła wskazać każde istniejące niearchiwalne zadanie tego projektu. Filtr outbound `scope` ogranicza powiadomienia, nie nadaje praw. Do zadania archiwalnego lub usuniętego adapter odmawia operacji. Nie dodajemy ukrytej kontroli dostępu per task, której produkt obecnie nie ma.

1. Użytkownik wybiera włączenie komunikacji i potwierdza użycie dedykowanego bota. UI wyjaśnia, że odpowiedzi mogą sterować agentem i uruchamiać dalszą pracę w istniejącej sesji.
2. Serwer generuje losowy challenge: 32 bajty z CSPRNG, base64url z prefiksem mieszczącym się w 64 znakach. Ważny 5 minut; przechowuje hash, identyfikator powiązania, generację i czas. Maks. 3 oczekujące challenge na projekt. Nie zapisuje jawnego kodu w logach, zdarzeniach ani telemetrii.
3. Człowiek otwiera prywatny deep link i wysyła `/start <kod>`. Wymagamy `from.id`, `is_bot === false` i czatu prywatnego. To potwierdza posiadanie konta; nie nadaje jeszcze praw.
4. Serwer atomowo zużywa challenge, zapisuje kandydata i pokazuje w cockpicie jego numeryczne ID, nazwę wyświetlaną i username jako nieautorytatywne etykiety. Bot oraz cockpit pokazują ten sam krótki kod porównawczy. Właściciel sprawdza zgodność i zatwierdza uprawnienia. Kandydat wygasa po 5 minutach.
5. Grant dotyczy dokładnie `(project, botId, targetChatId, telegramUserId)`. Prywatny czat docelowy musi być czatem sparowanego użytkownika. Dla grupy parowanie nadal jest prywatne, ale cockpit jawnie wskazuje grupę, w której ta osoba będzie mogła sterować cezar.
6. Zatwierdzenie włącza powiązanie; bot wysyła krótkie potwierdzenie do docelowego czatu. Błąd tego powiadomienia nie powtarza nadania uprawnień.

Nie autoryzować „pierwszego, kto kliknie link”, samego chat ID, username, administratorów grupy ani wszystkich jej członków. Dodanie bota do grupy nie jest zgodą na zdalne sterowanie. Link skradziony przed użyciem może co najwyżej podstawić kandydata, którego właściciel musi odrzucić.

### 5.2 Uprawnienia

| Uprawnienie | Operacja | Domyślny wybór podczas zatwierdzania |
| --- | --- | --- |
| `read` | status i ograniczona lista zadań | tak |
| `reply` | wiadomość do żywego zadania bez oczekującego pytania | tak |
| `answer` | tekstowa odpowiedź na konkretne aktualne pytanie/Guard | tak, z jednoznacznym opisem skutku |
| `cancel` | anulowanie po osobnym potwierdzeniu | nie |
| `continue` | wznowienie istniejącego zadania po potwierdzeniu kosztu | nie |

Żadne uprawnienie nie działa przed zatwierdzeniem. Granty przyznaje/zmienia/cofa wyłącznie cockpit; Telegram nie służy do rozszerzania własnych praw. Sprawdzamy je przed odczytem danych projektu i ponownie tuż przed skutkiem. Każda zmiana zwiększa generację i unieważnia oczekujące akcje. Przy odebraniu dostępu nie trzeba czekać na następny poll.

`reply` nie jest sandboxem: polecenie skierowane do aktywnego agenta może prowadzić do modyfikacji kodu i dalszych kosztów. Dokumentacja nie może obiecywać, że tylko `continue` kosztuje. `answer` może odblokować decyzję Guard; nie jest jednak akceptacją niskopoziomowego tool approval dostawcy ani osobną zgodą na merge.

## 6. Rozmowa i routing do zadania

### 6.1 Natywne odpowiedzi

Odpowiedź na powiadomienie bota rozpoznajemy przez klucz `(botId, chatId, reply_to_message.message_id)`. Wymagana trwała korelacja z dostawy cezar. Nie ufamy zacytowanemu tekstowi, tytułowi zadania, przekazanej wiadomości ani samemu `reply_to_message.from.username`.

Korelacja zawiera: project identity, receiver ID i deliveryRevision, binding generation, run ID, continuation, rodzaj powiadomienia, czas wysyłki; dla pytania także fingerprint opisany niżej. Ta sama nazwa zadania w innym projekcie nie ma znaczenia. Odpowiedź w innym czacie jest odrzucana. Wiadomości do innego bota są ignorowane.

- Jeśli powiadomienie dotyczy nadal aktualnego pytania: wymagane `answer`, odpowiedź trafia do tego pytania.
- Jeśli dotyczy żywego zadania bez pytania: wymagane `reply`, zwykła wiadomość do sesji.
- Jeśli pojawiło się nowe pytanie albo zmieniła kontynuacja: odrzucenie jako nieaktualne, bez automatycznego przekierowania na nowe pytanie.
- Jeśli zadanie jest zakończone albo sesja nie istnieje: odpowiedź nie uruchamia automatycznie Continue. Bot wskazuje jawne `/continue`, jeżeli użytkownik ma uprawnienie.
- Przy braku mapowania: „Nie mogę przypisać tej odpowiedzi. Użyj /reply <task-id> … albo cockpitu”. Nie zgadujemy ostatniego zadania.

Powiadomienie o pytaniu zawiera instrukcję użycia Reply. Opcjonalne `ForceReply` służy tylko wygodzie, nie autoryzacji. W grupie wiadomości bez Reply lub jawnej komendy nie są kierowane do agenta. Tak samo w prywatnym czacie: brak ukrytej reguły „ostatnia aktywna sesja”.

### 6.2 Komendy

Komendy obsługuje parser zamkniętego słownika, nigdy shell ani model. W grupach wymagany adresat `@botUsername` lub natywna odpowiedź na wiadomość bota; komenda do innego bota jest ignorowana. Limity: 4000 znaków tekstu polecenia, brak załączników, maks. 10 pozycji na stronie listy. Skrócone task ID rozwiązywać istniejącym mechanizmem referencji tylko w dozwolonym projekcie; niejednoznaczność oznacza błąd, nie pierwszy wynik.

| Wejście | Zachowanie |
| --- | --- |
| `/help` | dla autoryzowanych opis dozwolonych komend; dla nieznanych tylko ogólna instrukcja parowania bez danych projektu |
| `/tasks` | maks. 10 niearchiwalnych zadań, paginacja niejawnie nie ujawnia innych projektów |
| `/status <task>` | status i bezpieczne metadane zgodne z profilem treści odbiorcy |
| `/reply <task> <tekst>` | dla żywego zadania bez pytania: send/enqueue/defer; gdy jest pytanie: preview z fingerprint i potwierdzenie skierowania tekstu do tego pytania |
| Reply do znanego pytania | bez dodatkowego kliknięcia, jeśli fingerprint nadal aktualny i jest `answer` |
| `/cancel <task>` | preview, potem jednorazowe potwierdzenie przez tego samego użytkownika w tym samym czacie |
| `/continue <task> [tekst]` | preview z zadaniem, zapisanym dostawcą/kontem i ostrzeżeniem o kosztach; potwierdzenie; brak wyboru innego dostawcy i brak automatycznego fallbacku |

Preview wygasa po 120 sekundach. Callback przenosi losowy identyfikator, nie token, tekst ani uprawnienia. Mieści się w limicie Bot API. Serwer sprawdza autora, czat, grant generation i stan zadania przy każdym użyciu. Dwa kliknięcia dają jeden skutek. Callback szybko dostaje `answerCallbackQuery`, lecz „Odebrano” nie znaczy „Wykonano”; wynik jest osobną wiadomością. Starszy callback nie może odtworzyć usuniętej akcji.

Nieznany/nieuprawniony użytkownik nie dostaje nazw zadań ani szczegółów błędu. W grupie preferujemy ciszę; odpowiedź ogólna jest limitowana do 1/min na czat. Nie wysyłamy prywatnej wiadomości z danymi projektu jako fallbacku z błędu grupy.

### 6.3 Aktualność pytania i konkurencja z UI

Fingerprint: hash kanonicznej reprezentacji `(runId, continuation, requestId, askedAt, pełna dostępna treść pytań i opcji)`. Nie wystarcza `requestId`. Przechowujemy hash i niezbędne identyfikatory; nie kopiujemy całego pytania do indeksu korelacji.

Wspólny mechanizm przyjęcia wiadomości musi atomowo sprawdzić i zarezerwować oczekujące pytanie PRZED zwróceniem przyjęcia, także gdy rzeczywiste dostarczenie czeka na lease lub proces. Kolejna odpowiedź na to samo pytanie jest odrzucana. Rezerwacja dotyczy i UI, i Telegrama: samo sprawdzenie snapshotu w adapterze Telegrama nie wystarczy.

Dodać opcjonalny `expectedAttention` do kontraktu messages/continue i przesyłać go z cockpitowej karty pytania. Zwykły composer pozostaje zgodny wstecz, ale wspólna sekcja krytyczna musi unieważnić/zająć bieżące pytanie również przy przyjęciu niestrukturyzowanej wiadomości użytkownika, skoro tak działa obecny silnik. Używać serializacji per run, nie globalnego locka. Po asynchronicznych kontrolach konta/dostawcy sprawdzić stan ponownie. Nie zamykać pytania na zawsze po odmowie przed przyjęciem; jeśli nie wiadomo, czy wysłano do dostawcy, oznaczyć niepewność zamiast automatycznie powtarzać.

Nie implementujemy przycisków pojedynczego wyboru na podstawie projekcji, która utraciła `multiSelect`. Użytkownik odpowiada tekstem; wieloczęściowa odpowiedź może zawierać numerację. Jeśli treść pytania została skrócona, wiadomość wyraźnie wskazuje pominięcie i kieruje do pełnego widoku. Nie konstruujemy pozornie kompletnego formularza.

## 7. Wspólna warstwa operacji na zadaniu

Wydzielić z istniejących handlerów messages/continue/cancel mały `RunInteractions` (nazwa robocza, moduł w pakiecie cezar). Korzystają z niego zarówno HTTP, jak i adapter Telegrama. Autoryzacja źródła pozostaje na granicy kanału; reguły operacji są wspólne.

Zachować:

- sprawdzanie dostawcy i właściwego zapisanego profilu, blokady modeli i kont;
- obecną kolejność send → enqueue → defer, odmowę niedozwolonej kolejki i semantykę odpowiedzi;
- ochronę przed zmianą lifecycle, resetem, sprzątaniem worktree i aktywną sesją przy Continue;
- brak automatycznego uruchamiania nowego zadania po porażce dostarczenia;
- odrębność `cancel`, `finish` i `land`; adapter nie wywołuje dwóch ostatnich;
- idempotencję istniejącego HTTP i zgodność jego odpowiedzi.

Nie wywoływać localhost HTTP z workera ani bezpośrednio prywatnego `deliverMessage`. Nie omijać handlerowych kontroli przez prosty `manager.sendMessage`. Autoryzować projekt zanim zostanie leniwie utworzony jego kontekst. Odkrywanie botów i nieuprawnione aktualizacje nie mogą uruchamiać RunManagerów/recovery wszystkich projektów.

Odpowiedź w Telegramie odzwierciedla wynik: „Przekazano”, „Dodano do kolejki”, „Czeka na uruchomienie sesji”, „Odrzucono” lub „Wynik niepewny — sprawdź zadanie”. Żadna z pierwszych trzech nie oznacza wykonania polecenia przez agenta. Późniejsze wyniki idą istniejącymi zdarzeniami webhooków; nie wprowadzamy sztucznych typów zdarzeń do kolejki tylko po to, by wysłać potwierdzenie komendy.

## 8. Odbiór, trwałość i granice gwarancji

### 8.1 Polling

Long polling `getUpdates`: timeout Telegrama 25 s, całkowity deadline żądania 35 s obejmujący DNS, body i shutdown. Jedno żądanie na bota, batch 50. Zachować przypięty DNS, brak redirectów, publiczne adresy, stały host i limit body 1 MiB. Oddzielić timeout konfiguracji od long pollingu; nie zwiększać globalnego timeoutu wszystkich webhooków.

W aktywnym inbound wysyłać jawnie `allowed_updates: [message, callback_query, my_chat_member]`; zmiana ustawienia jest elementem zgody na dedykowanego bota. Starsze nieobsługiwane typy należy odrzucić i potwierdzić bez wykonania. Discovery-only nie zmienia tego ustawienia.

Jeżeli odpowiedź przekracza limit, ponowić ten sam offset z batch 10, następnie 1. Gdy nawet 1 nie mieści się w limicie, przejść do stanu wymagającego interwencji; bez potwierdzenia nieprzeczytanych danych i bez gorącej pętli. Nie udawać, że dane zostały przetworzone.

Błędy sieci i 5xx: backoff z jitterem 1–60 s, reset po sukcesie. Telegram 429: respektować `retry_after` jako dolną granicę, bez obcinania prowadzącego do wcześniejszego ponowienia; nadmierna wartość oznacza długi cooldown z możliwością wyłączenia. 401/utrata sekretu: stan credentials unavailable. 409: konflikt, zatrzymanie do jawnego wznowienia. Pozostałe 4xx: diagnostyka ze stałego słownika, zatrzymanie zamiast nieskończonej pętli.

### 8.2 Zapis i potwierdzanie aktualizacji

Nowy magazyn ma jednego właściciela lease. Atomowo zapisuje znormalizowaną partię inbox, wyniki odrzuceń i następny offset, ZANIM kolejne `getUpdates` potwierdzi poprzednią partię. Zapis musi być trwały (fsync pliku przed rename i obsługa trwałości katalogu na obsługiwanych platformach), nie tylko aktualizacja pamięci. Test awarii musi obejmować każde miejsce między zapisem a HTTP.

Nie zapisujemy całego JSON Telegrama. Dla autoryzowanej komendy zachowujemy wymagany tekst, actor/chat/update ID, timestamp, ewentualny reply ID i generation. Nieautoryzowane wiadomości nie trafiają do transkryptu ani trwałego inbox z treścią; wystarcza zbiorczy licznik i kursor. Parser przyjmuje wyłącznie obsługiwany tekst; odrzuca wiadomości edytowane, forwardy, `sender_chat`/anonimowych nadawców, wiadomości od botów i `via_bot`, kanały, forum oraz media. `my_chat_member` służy tylko do unieważnienia dostępu bota, nie wykonuje poleceń.

Nowe włączenie/parowanie ustala `acceptAfter`. Aktualizacje sprzed tej chwili są odrzucane jako backlog. Dodatkowo mutacje tekstowe starsze niż 15 minut lub z czasem przyszłym >60 s nie są wykonywane. Odbiornik po restarcie może opróżnić starszą kolejkę, ale nie uruchamia starych poleceń. Callback nie ma równoważnego czasu wiadomości nadawcy: świeżość zapewnia zapisana akcja, TTL i generation.

ID zapisujemy jako kanoniczne stringi; wejściowe liczby muszą być bezpiecznymi liczbami całkowitymi. Offset to zwalidowane ID + 1 dla przetworzonej partii. Nie zakładać nieograniczonej monotoniczności: po co najmniej 6 dniach bez aktualizacji rozpocząć nową epokę odczytu, trwale zapisać ją i jednorazowo odpytać bez starego offsetu. Chroni to przed losową numeracją po tygodniu; filtrowanie czasu i acceptAfter nadal obowiązuje. Nie resetować epoki przy każdym pustym pollu. Klucz deduplikacji: bot ID + epoka + update ID.

### 8.3 Wykonanie i awaria

Stany akcji: `pending → claimed → accepted | rejected | uncertain`. `pending` jest trwały; dispatcher ponownie sprawdza TTL, grant i stan zadania. `claimed` zapisać trwale PRZED wejściem do mechanizmu skutku. Po restarcie każde nierozstrzygnięte `claimed` staje się `uncertain` i NIE jest automatycznie wykonywane ponownie. Dotyczy to także awarii tuż przed faktycznym wywołaniem — świadomie wolimy wymagać sprawdzenia niż powtórzyć kosztowną operację.

Nie obiecujemy exactly-once między plikiem, silnikiem i zewnętrznym procesem agenta. Gwarancja V1: najwyżej jedna automatyczna próba mutacji dla przyjętej akcji; duplikat aktualizacji/callbacku zwraca zapisany wynik. W niepewności użytkownik sprawdza transkrypt/status, po czym może świadomie wysłać nowe polecenie. In-memory `MessageReceipts` nie zastępuje tego dziennika.

Wysłanie potwierdzenia do Telegrama jest oddzielną operacją w trwałej, ograniczonej kolejce odpowiedzi. Porażka potwierdzenia nie uruchamia ponownie akcji. Sieciowa niepewność `sendMessage` może dać duplikat komunikatu; komunikat zawiera krótki identyfikator akcji, a duplikat nie daje nowej autoryzacji. Nie obiecywać exactly-once dla samych wiadomości Telegrama.

### 8.4 Limity i retencja

Stałe produktu, nie nowy plik konfiguracji: do 1000 oczekujących akcji i 16 MiB inbox na bota; do 1000 odpowiedzi/8 MiB outbox kontrolnego; tekst do 4000 znaków; do 20 autoryzowanych wejść/min na użytkownika i 60/min na bota. Mutacje serializowane per run, maks. 4 niezależne akcje na bota jednocześnie. Limity nie powodują usunięcia nieprzetworzonej partii: przy pełnym inbox worker przestaje pobierać, a UI pokazuje capacity blocked. Nieuprawniony spam jest odrzucany przed przydzielaniem kosztownego zadania.

Treść zakończonej akcji usunąć po 24 h; potwierdzenia/deduplikacja bez treści 7 dni (maks. 100 tys. rekordów); korelacje powiadomień 7 dni i maks. 20 tys. na bota. Pending/claimed/uncertain nie usuwać zwykłym TTL przed rozstrzygnięciem lub jawnym porzuceniem; ich liczba nadal podlega limitowi. Przed wyrzuceniem receipt z powodu pojemności nie dopuścić do ponownego wykonania starego update: wysoki kursor w epoce i filtr czasu pozostają. Jeśli zachowanie tej gwarancji jest niemożliwe, zatrzymać odbiór, nie usuwać zabezpieczeń.

Limiter wysyłek kontrolnych jest wspólny per bot dla odpowiedzi i istniejących dostaw; wprowadzić go bez osłabienia obecnych limitów. Konserwatywne tempo domyślne: 1 wiadomość/s/czat i 10/s/bot, z nadrzędnym cooldown z 429. Przydział fair między czatami; callback acknowledgement ma pierwszeństwo, ale nie omija cooldown właściwego dla swojego API. Jedna zajęta grupa nie może zagłodzić wszystkich odbiorców.

## 9. Minimalne potwierdzenie wysyłki i korelacje

Rozszerzyć wewnętrzny `SendResult` dla Telegrama o zwalidowane `{ messageId, chatId }`. Parser udanego body wybiera tylko te pola z wyniku; odrzuca treść, dane użytkownika i pozostałe właściwości. Nie używać tego body jako `responseExcerpt`. Zachować limit odpowiedzi i redakcję wyjątków. Dostawa bez poprawnego potwierdzenia może być dostarczona, ale nie może uzyskać fikcyjnej korelacji.

Korelację zapisać trwale przy complete, przed oznaczeniem dostawy jako dostarczonej. Awaria między Telegramem a zapisem pozostaje niepewnością: nie mapujemy na podstawie tekstu odpowiedzi. Odpowiedź bez mapowania korzysta z jawnej ścieżki `/reply`. Zapisać korelacje również dla potwierdzeń/preview, jeśli mają być obiektami Reply; nie każde techniczne potwierdzenie ma prowadzić do zadania.

Zmiana chat ID, formatu, token generation lub deliveryRevision unieważnia stare interakcje. Nie przenosimy grantów na nowego bota, nawet gdy username wygląda tak samo. Rotacja tokena tego samego bota zatrzymuje odbiór, wymaga ponownego udanego testu i jawnego wznowienia inbound; tożsamości grantów można zachować jako zawieszone, lecz stare akcje i challenge wygasają.

## 10. Stan, przechowywanie i bezpieczeństwo

Projektowy stan nowego modułu: `.ai/cezar/webhooks/telegram/` (w dry-run pod istniejącą odizolowaną ścieżką dry-run). Użyć schematów Zod z wersją i atomowego magazynu. W stanie są powiązania, granty, cursor/epoka, inbox/receipts, korelacje i odpowiedzi. Referencja tokena pozostaje w istniejącym rejestrze/sejfie; brak drugiej kopii tokena, brak eksportu do `process.env` i promptu. Katalog 0700, pliki 0600, walidacja ignorowania przez git i bezpieczne otwieranie bez podążania za podstawionymi symlinkami jak dla wrażliwego stanu istniejących webhooków.

Format V1: jeden `telegram/<botId>/state.json` na bota/projekt, schemaVersion=1. Pola: projectIdentity, canonicalRoot, installationId, botId, configurationRevision, bindings, grants, intake (epoch, nextOffset, acceptAfter, lastUpdateAt, epochResetAt), inbox, receipts, correlations i responseOutbox. Przechowywać oddzielnie krótkotrwałe challenge w pamięci; restart unieważnia niezakończone parowanie i wymaga wygenerowania linka ponownie. Przyjęte granty są trwałe. Losowy identyfikator instalacji znajduje się pod `cezarHomeDir()/telegram/installation.json`, utworzony atomowo pod lockiem; jego brak po utracie home unieważnia poprzednie granty.

Każdy zapis stanu bota jest serializowany i zastępuje cały snapshot atomowym tmp/fsync/rename; nie rozdzielać inbox i kursora na niezależne zapisy. Cache stanu tylko pod utrzymywanym lease; przed odzyskaniem odczyt z dysku. Hard cap snapshotu 64 MiB, z wcześniejszą retencją zakończonych rekordów, a potem capacity-blocked. To celowo prosty magazyn dla małego ruchu sterującego; nie dodawać bazy danych. Jeżeli pomiary uzasadnią journal, jego zmiana wymaga osobnego dowodu crash consistency zamiast cichego osłabienia gwarancji snapshotu.

Stan wiąże się z canonical project root, project identity i instalacją. Skopiowanie katalogu do innego root/projektu nie nadaje uprawnień: odczytać jako nieaktywne, zażądać parowania. Brak/uszkodzenie pliku autoryzacji oznacza brak autoryzacji, nigdy puste „allow all”. Niekompatybilna wersja zatrzymuje tylko inbound; nie nadpisywać uszkodzonego stanu pustym plikiem. Usunięcie nowego katalogu przywraca stan wyłączony bez grantów. Usunięcie lease nie może umożliwić równoległego wykonania bez ponownej weryfikacji właściciela.

Treść uprawnionej odpowiedzi jest danymi użytkownika jak istniejący transkrypt zadania, a nie sekretem do sejfu. UI i dokumentacja wyjaśniają tę retencję. Redagować znane tokeny w diagnostyce; nie obiecywać rozpoznania każdego sekretu wpisanego przez człowieka. Nie logować raw update, tokena w URL, kodów parowania ani callback payload z treścią. Telemetria nie dostaje user/chat ID, tekstów, nazw projektu i zadań.

Ograniczyć informacje wysyłane przez `/status` i `/tasks` do profilu treści receivera. Minimal pozostaje Minimal: bez pełnego pytania, transkryptu i szczegółów błędu. Wtedy odpowiedź na pytanie wymaga otwarcia cockpitu albo świadomej zmiany profilu na Standard w cockpicie; nie obchodzić ograniczenia przez komendę. Standard nadal nie oznacza eksportu całej historii. Linki do zadań podlegają obecnej polityce linków lokalnych/hosted; nie wysyłać bezużytecznego localhost do telefonu ani nie dodawać tunelu.

## 11. Stany i źródła wyjścia

| Stan | Przyczyna wejścia | Wyjście |
| --- | --- | --- |
| disabled | domyślny stan, flag off, wyłączenie przez użytkownika | jawne włączenie po spełnieniu warunków |
| pairing | challenge z UI, tymczasowa zgoda na odbiór | zatwierdzenie → active; timeout/anulowanie → disabled, jeżeli brak innych aktywnych bindingów |
| active | aktywny receiver, grant, lease, sekret | aktualizacja, awaria, cofnięcie zgody, shutdown |
| backoff | sieć/5xx/429 | timer respektujący Retry-After; wyłączenie przerywa timer |
| paused | odbiorca paused/disabled, zmiana konfiguracji, członkostwa bota | naprawa, test i jawne wznowienie w UI |
| credentials-unavailable | 401, brak/zmiana fingerprint sekretu | zapis poprawnego tokena, test i jawne wznowienie |
| conflict | webhook, zewnętrzny poller, cudzy lease | naprawa konfliktu i jawne ponowienie; żadnego automatycznego przejmowania |
| context-unavailable | usunięty/brakujący projekt/root | przywrócenie projektu i jawne włączenie; usunięcie projektu usuwa granty ze sterowania |
| capacity-blocked | pełny magazyn / nieobsługiwalny rozmiar | drenaż/naprawa i kontrolowane wznowienie; żadnego nieskończonego retry |
| stopped | zamknięcie serwera | następny start po weryfikacji zapisanego opt-in i grantów |

Usunięcie bota z czatu i migracja grupy do supergrupy zawieszają binding; nie przepisywać grantów na nowe chat ID z samego komunikatu migracji. Ponowne przypisanie czatu, test i zatwierdzenie w cockpicie są jawne. Stan receivera `suspended` traktować tak samo jak `paused` dla odbioru.

Stan bota i stan poszczególnych bindingów są rozdzielone: zawieszenie jednego receivera nie wyłącza innych poprawnych czatów tego samego bota. Brak aktywnych bindingów i pairing zatrzymuje poller i zwalnia lease. Grant cofnięty w trakcie long pollu obowiązuje natychmiast przy dispatchu pobranych danych.

Shutdown: przestać przyjmować nowe akcje, abort long poll i timery, dać maks. 5 s na domknięcie zapisów/zaakceptowanych operacji, zachować nierozstrzygnięte claimed, zamknąć transport, zwolnić lease dopiero po zaprzestaniu pracy. Boot/recovery nie może zawisnąć na sieci. Inbound jest dodatkiem do serwera, nie osobnym daemonem.

## 12. Kontrakt HTTP i UI

Nowa rodzina tras projektu, montowana raz przez chain pod `/api/v1/telegram` i `/api/v1/p/:projectId/telegram`, alias `default` zgodny z istniejącą konwencją. Nie są to endpointy dla serwerów Telegrama. Chroni je istniejący request-origin guard; nie poszerzać CORS, Host ani dostępu hosted.

Proponowane kształty muszą być najpierw zdefiniowane w `packages/contract`, a typy wyprowadzone z Zod:

| Metoda/ścieżka rodziny | Request | Response |
| --- | --- | --- |
| GET `/` | brak | capabilities, receiver bindings, status bota, rewizja, bez sekretów |
| POST `/pairings` | receiverId, expectedRevision, requestedPermissions, dedicatedBotConsent=true | pairingId, expiresAt, jednorazowy deepLink, revision |
| GET `/pairings/:id` | UUID | state, expiresAt, opcjonalny kandydat z userId/displayName/username, verificationCode |
| POST `/pairings/:id/confirm` | expectedRevision, candidateUserId, permissions | grant i nowa revision |
| DELETE `/pairings/:id` | UUID | cancelled boolean |
| PATCH `/receivers/:id` | expectedRevision, enabled boolean | binding i revision; enabled=true tylko przy aktualnych grantach i teście |
| PATCH `/grants/:id` | expectedRevision, permissions | grant i revision, z podniesioną generation |
| DELETE `/grants/:id` | expectedRevision jako walidowane query | revoked boolean i revision |
| POST `/receivers/:id/resume` | expectedRevision | status i revision; pełna ponowna kontrola warunków |

Body/path/query walidowane przez middleware repozytorium; żadnego ręcznego API interface, luźnego `app.post`, ani parsera body ukrytego w handlerze. Brak tokena w tych requestach: używają zapisanego receivera. Pierwsze Connect chat nadal korzysta z własnego istniejącego kontraktu przed zapisem receivera.

Wspólne DTO: `revision` i `generation` to nieujemne safe integers; UUID dla pairing/grant/binding/receiver; Telegram IDs to kanoniczne signed decimal strings (user/bot wyłącznie dodatnie); daty ISO UTC. `permissions` jest unikalną tablicą zamkniętego enum z §5.2, maks. 5 elementów. `Grant` zawiera id, receiverId, botId, chatId, userId, permissions, generation, createdAt i opcjonalne etykiety do 256 znaków. `Binding` zawiera receiverId, botId, chatId, enabled, generation, state z §11 i grant IDs. `capabilities` zawiera available oraz opcjonalny zamknięty reason (`flag_off`, `webhooks_off`, `hosted`, `unsupported_chat`). Status obejmuje state, lastSuccessfulPollAt i retryAt jeśli istnieją; nie zawiera URL z tokenem ani surowego błędu dostawcy. Status pairing to `waiting`, `candidate`, `confirmed`, `expired`, `cancelled`; dane kandydata występują tylko dla `candidate`. Nie zwracać deep linka ponownie w GET. Revision dotyczy konfiguracji projektu, nie rośnie przy każdym pollu ani statusie zdrowia.

Odpowiedzi błędów zachowują `{error}` i dodają ustalony `code` w nowym kontrakcie: 400 invalid input/unsupported chat, 404 missing resource, 409 stale revision/bot ownership/invalid state, 429 rate limited z Retry-After, 503 unavailable credentials/feature/context. Wyłączona funkcja nie powinna powodować znikania metadanych możliwości UI; mutacje odmawiają bez sieci. Schemat musi odpowiadać dokładnie temu, co route serializuje, także opcjonalne pola.

UI: „Two-way communication” z osobną listą osób i uprawnień, stanem ostatniego udanego odbioru, komunikatem konfliktu, możliwością wyłączenia/odebrania dostępu i ponowienia. Przed aktywacją pokazać zakres projektu i czatu, liczbowe user ID i opis kosztów. Nie używać etykiety „Connected”, gdy jest tylko wykryty czat albo oczekujący kandydat. Statusy w małym `aria-live=polite`, nie cały formularz z przyciskami. Obsługa klawiatury, focus po zatwierdzeniu/cofnięciu, cancel i powrotu po błędzie.

Aktualizacje UI wykorzystują istniejące zdarzenia/inwalidację SSE; ewentualny nowy temat WS musi spełniać zasady demand-driven i nie przenosić kodu, kandydata ani danych prywatnych. Odczyt szczegółów idzie uwierzytelnioną istniejącą ścieżką HTTP. Nie tworzyć nowego socketu na komponent ani stałego browser pollingu jako właściciela integracji. Tymczasowe sprawdzanie statusu pairing można zachować przez istniejący broker konfiguracji z anulowaniem, ale jego zakończenie nie zatrzymuje aktywnego pollera serwera.

## 13. Plan wykonania i granice zmian

Wykonywać kolejno; to sprzężona zmiana, nie dzielić edycji server.ts/run.ts między niezależnych wykonawców.

1. **Kontrakt i refaktoryzacja operacji.** Schematy nowego API, expectedAttention; wydzielenie RunInteractions. Testy istniejącego HTTP muszą pozostać zielone, zanim podłączy się Telegram. Dodać atomowe przyjęcie pytania obejmujące UI i Telegram, wszystkie konstrukcje ActiveRun, start/continue/recovery.
2. **Magazyn i własność.** Schematy stanu, inbox/receipts, lease bota, epoki, retention, fault injection. Brak sieci do czasu udowodnienia zachowania crash recovery i revocation.
3. **Transport odbioru i broker.** Poller, bounded parser, abort/deadline, retry/cooldown, wspólna obsługa discovery i pairing; usunąć konkurujący getUpdates z aktywnego przepływu Connect chat, zachowując discovery-only.
4. **Autoryzacja i API.** Parowanie dwuetapowe, granty, rewizje, feature gates, singleton per bot. Typed client, contract parity i scoped/unscoped parity.
5. **Korelacja outbound.** Minimalny receipt sendMessage, trwałe mapowanie, redakcja i deliveryRevision. Zachować gwarancje istniejącej kolejki i profile treści.
6. **Rozmowa.** Parser komend, adapter RunInteractions, native Reply, potwierdzenia cancel/continue, durable action receipts i outbox kontrolny. Wszystkie sprawdzenia autoryzacji przed dostępem do zadania.
7. **UI i dokumentacja.** Settings, karta pytania z expectedAttention, dostępność, dry-run/e2e; opisy ograniczeń, naprawy konfliktów, utraty danych i token rotation.
8. **Weryfikacja całości.** Matryca poniżej, build, regresje innych providerów, przegląd diffu. Test na żywym bocie wyłącznie z osobnym pozwoleniem i testowymi danymi, bez wklejania tokena do repozytorium.

Nowy kod nie może nadpisać pojedynczego lifecycle observera: rozszerzyć istniejącą koordynację o fan-out z izolacją wyjątków albo przekazywać już utworzone zdarzenie do modułu korelacji. Dla danej zmiany stanu nadal powstaje jedno logiczne zdarzenie outbound; fan-out nie dubluje enqueue. Ewentualny nowy hook ma test, że awaria inbound nie zatrzymuje pozostałych obserwatorów.

Nowe moduły sugerowane pod `packages/cezar/src/telegram/`: coordinator, polling, storage, authorization, interactions, correlation, commands. Każdy ma wąską odpowiedzialność i czytelną wielkość; nie budować frameworka integracji wszystkich komunikatorów. Współdzielony transport bezpieczeństwa można wydzielić z webhooks, nie kopiować. Nie rozszerzać zakresu sejfu na Slack/Discord.

Dokumentacja wymagana przy implementacji: ten spec z oznaczeniem statusu, outbound spec z linkiem do rozszerzenia, `packages/cezar/docs/webhooks.md`, `BACKWARD_COMPATIBILITY.md` z nowymi trasami i stanem, `.env.example`, tabela env w dokumentacji reference. Jeżeli powstaną katalogi poza już ignorowanym `webhooks/`, zaktualizować `ensureDataGitignore` i jego testy. Zmiany nie mogą wymagać ręcznej migracji plików użytkownika. Starsza wersja bez inbound nadal wysyła outbound; nie zmieniamy formatu istniejącego endpointu w sposób konieczny do jego parsowania przez tę wersję.

## 14. Matryca testów i warunki odbioru

### A. Scenariusze użytkownika

1. Private: wykrycie czatu → test odbiorcy → Start pairing → zatwierdzenie → pytanie → native Reply → przyjęcie w prawidłowym zadaniu → wynik w tym samym czacie.
2. Grupa z privacy mode: dwie sparowane osoby mają różne prawa; odpowiedź uprawnionej działa, odpowiedź innego członka nie odczytuje nawet danych zadania. Komenda do innego bota niczego nie uruchamia.
3. Dwa zadania z podobnym tytułem i równoległymi pytaniami: brak skrzyżowania odpowiedzi; short ID collision daje błąd. Dwa projekty nie mogą przejąć tego samego bota inbound.
4. Odpowiedź na stare pytanie po Continue z takim samym requestId jest odrzucona. Jednoczesna odpowiedź w UI i Telegramie przyjmuje tylko jedną, także przy opóźnionym lease sesji.
5. Zamknięcie przeglądarki nie zatrzymuje rozmowy; zamknięcie pairing formularza zatrzymuje tylko pairing. Connect chat przy działającej rozmowie nie otwiera drugiego getUpdates.
6. `/continue` bez prawa/bez potwierdzenia nie uruchamia płatnej pracy. Konto niedostępne, zablokowany model i aktywna sesja zachowują obecne odmowy. Reply do zakończonego zadania nie wznawia go.
7. Cofnięcie prawa po preview, ale przed kliknięciem, blokuje akcję. Drugi użytkownik i inny czat nie mogą użyć callbacku. Dwuklik nie dubluje cancel/continue.
8. Minimal nie ujawnia pełnego pytania ani promptu przez status/listę/reply preview; Standard zachowuje poprawne escaping i limity wiadomości.

### B. Trwałość i transport

9. Restart przed zapisem partii, po zapisie/przed ack, po ack, przed claimed, po claimed/przed skutkiem, po skutku/przed receipt oraz po receipt/przed potwierdzeniem. Oczekiwany wynik każdego punktu zapisany w teście; żadnego automatycznego ponowienia uncertain.
10. Duplikaty update i callback, różne kolejności, duplikaty powiadomień outbound i utrata mapowania message_id. Fallback nigdy nie rozpoznaje zadania po cudzym tekście.
11. Pierwsze 100+ starych aktualizacji nie blokuje aktywnego konsumenta: trwale odrzuca backlog i przesuwa offset. Discovery-only zachowuje ostrzeżenie bez konsumowania.
12. Nowy losowy updateId mniejszy od starego po długiej bezczynności; jednorazowa zmiana epoki, brak nieskończonego resetu offsetu i brak wykonania starego polecenia.
13. 429 z dużym retry_after nie jest ponawiane wcześniej; 409 zatrzymuje; DNS/body wiszące kończą się deadline; shutdown przerywa poll/backoff. Payload >1 MiB wyczerpuje kontrolowaną redukcję batch i blokuje bez ack.
14. Rotacja/usunięcie tokena, zmiana audience/fingerprint w sejfie, chat ID/format/deliveryRevision, paused/disabled receiver, odebranie członkostwa bota. Brak użycia starego sekretu i brak przeniesienia grantów.
15. Dwa procesy i crash właściciela lease, PID reuse, zablokowany/read-only home, uszkodzony stan, utrata katalogu, skopiowany root. Nie ma fail-open ani awarii całego cockpitu.
16. Pełny inbox/outbox, retencja i wolny jeden czat; brak bezgłośnego odrzucania przyjętych mutacji i brak zagłodzenia pozostałych czatów.

### C. Bezpieczeństwo i kontrakt

17. Malformed IDs, brak from, bot/anonymous/forward/edit/channel/forum/media, zmieniony username, skradziony/zużyty/przeterminowany challenge, brute force tokenów akcji. Żaden nie daje praw.
18. SSRF/DNS rebinding/redirect, token w wyjątkach i response body, echo wysłanej treści w success: utrzymane zabezpieczenia; bez raw body w logu/history/API. Test sekretu obejmuje jego rotację.
19. JSON response dokładnie pasuje do Zod, typy body są widoczne w AppType, każda trasa scoped/unscoped/default działa identycznie. CSRF/Host/CORS pozostają bez rozszerzeń.
20. Brak flag, brak grantów, hosted, CEZ_DRY_RUN: żadnej prawdziwej sieci ani procesu agenta. Dry-run używa odizolowanego sejfu/stanu i deterministycznych fixture'ów.
21. Regresje messages/queued/deferred/continue/cancel i obu ścieżek zakończenia tury. Obserwator lifecycle nadal obsługuje outbound Slack/Discord/JSON/Telegram.

### D. UI/e2e i polecenia weryfikacji

Testy React: parowanie, zatwierdzenie innej osoby, timeout i retry, revocation, focus/klawiatura, stale revision, brak wycieku tokena, mały region aria-live. E2E według repozytoryjnego skilla `.agents/skills/e2e/SKILL.md`, wzorowane na `packages/web/e2e/chat-webhooks.config.ts`. Nowy `telegram-bidirectional.config.ts`/fixture serwera uruchamia dry-run i wstrzykiwany, deterministyczny transport Telegrama; nie potrzebuje prawdziwego tokena. Nie dodawać produkcyjnej trasy pozwalającej podszyć się pod Telegram ani ustawienia dowolnego hosta API. Wszelkie testowe sterowanie tylko w istniejącym odizolowanym trybie harness.

E2E musi wykazać pełny obieg w syntetycznej rozmowie, anulowanie parowania, błąd trwały, cofnięcie grantów i konflikt równoległej odpowiedzi. Sprawdzić `.e2e/.../report.json`, nie tylko exit code. Używać semantycznych asercji agenta oraz deterministycznych sprawdzeń faktycznej liczby dostarczeń do mock RunInteractions.

Uruchamiać z repo root, zawsze z timeoutem. W przyszłej implementacji:

```sh
timeout 300 npm test -- packages/cezar/src/telegram packages/cezar/src/webhooks packages/cezar/src/server packages/web/src/routes/settings packages/web/src/routes/task-thread/ask-answer.test.ts
timeout 300 npm run typecheck
timeout 300 npm run test:unit
timeout 300 npm run build
timeout 300 npm test
timeout 300 ./node_modules/.bin/e2e run --config packages/web/e2e/telegram-bidirectional.config.ts
git diff --check
```

Jeżeli pełny zestaw przekracza limit, zapisać wynik timeoutu i uruchomić ograniczone części; nie raportować przejścia całego zestawu. Dla zmian działających mechanizmów wykazać przynajmniej raz, że nowy test regresji zawodzi po cofnięciu odpowiedniej poprawki. Nie wolno pomijać porażek jako „znanych” bez porównania z bazą.

**Definition of done:** wszystkie scenariusze A–C mają testy lub udokumentowaną, konkretną procedurę fault injection; podstawowe scenariusze A1–A5 automatyczne. Nowy kontrakt i e2e przechodzą, brak nowych porażek repozytorium, typecheck/build przechodzą, zachowane outbound i obecne guardy. Raport jawnie rozdziela symulację Telegrama i opcjonalny test live. Produkcyjna komunikacja nie może zależeć od otwartego formularza.

## 15. Weryfikacja wykonana przy pisaniu specyfikacji

Przeczytano przepływy wskazane w §2 i oficjalne źródła §3. Potwierdzono brak trwałego message receipt, brak korelacji message_id, ponowne używanie requestId i utratę multiSelect w projekcji webhooka. Przejrzano istniejący e2e harness i instrukcje skilla; nie uruchamiano przeglądarki ani żywego bota.

W bazie uruchomiono:

```sh
timeout 120 npm test -- packages/cezar/src/server/message-receipts.test.ts packages/cezar/src/server/queued-messages.test.ts packages/cezar/src/server/continue-run.test.ts packages/cezar/src/webhooks/telegram-secrets.test.ts packages/cezar/src/webhooks/telegram-connect.test.ts packages/web/src/routes/task-thread/ask-answer.test.ts
```

Wynik: **6 plików, 97 testów — wszystkie przechodzą**. To weryfikacja istniejących punktów integracji, nie dowód działania planowanej funkcji. Pozostałe testy §14 są obowiązkami przyszłej implementacji. Spec nie wymaga dostępu do rzeczywistego tokena ani migracji danych użytkownika w czasie planowania.

## 16. Gotowe zlecenie wykonania

> Zaimplementuj `.ai/specs/2026-10-27-telegram-bidirectional.md` w całości, w kolejności §13. Zachowaj istniejący outbound Telegrama i jego projektowy sejf. Dostarcz rzeczywistą komunikację dwukierunkową z natywnymi odpowiedziami w tym samym czacie oraz jednym wspólnym konsumentem dla rozmowy i Connect chat. Nie pomijaj parowania człowieka, kontroli aktualności pytań, durable inbox/receipts ani crash ambiguity. Wykonaj §14 i przedstaw dowody, a wyniki symulacji odróżnij od live. Pracuj lokalnie, bez ręcznego commita/pusha; nie używaj rzeczywistych sekretów ani nie wysyłaj prawdziwych wiadomości bez osobnego polecenia. Jeśli baza zmieniła się od wskazanego commita, sprawdź mechanizmy ponownie i aktualizuj spec wraz z uzasadnieniem, zamiast mechanicznie kopiować stare założenia.
