# Uruchamianie rozszerzeń w trybie hosted

Status: propozycja do implementacji. Specyfikacja nie zmienia obecnego zachowania.
Data: 2026-11-12.

## Cel biznesowy

Cezar na serwerze ma stale obsługiwać zatwierdzone rozszerzenia i boty, również przy zamkniętej przeglądarce. Administrator maszyny instaluje oprogramowanie i zatwierdza dostęp przez CLI. Użytkownik uwierzytelnionego panelu hosted korzysta z paneli, komend i formularzy zatwierdzonych dla projektu. Osoba zatwierdzona na komunikatorze może odpowiadać agentowi i wykonywać przyznane jej działania.

Specyfikacja dotyczy wspólnej platformy rozszerzeń: paneli, komend, formularzy, obsługi zdarzeń i dostawców integracji. Nie projektuje kreatorów konkretnych usług. Komunikatory są jednym z zastosowań mechanizmu, nie jego osią.

## Zakres i decyzje

- Jeden mechanizm rozszerzeń, instalatora, zgód, sekretów, adapterów i parowania dla local i hosted. CLI jest kolejnym interfejsem do istniejących usług domenowych.
- W hosted administracja oprogramowaniem, połączeniami i osobami odbywa się wyłącznie przez CLI na maszynie. Panel nie otrzymuje uprawnień administracyjnych.
- Dostęp hosted wymaga odrębnego, jawnego zatwierdzenia dokładnego artefaktu dla projektu. Istniejąca lokalna zgoda nie wystarcza. Samo przełączenie na `CEZ_REMOTE=1` niczego nie uruchamia.
- Nie dodajemy globalnej flagi automatycznie dopuszczającej wszystkie rozszerzenia. Zapis zgody przez CLI jest opt-in; nie trzeba ręcznie tworzyć ani edytować konfiguracji.
- Obsługujemy rozszerzenia z npm i zbudowanych katalogów oraz dostarczone adaptery Telegrama, Slacka i Discorda. Każdy istniejący rodzaj wkładu musi korzystać z tej samej polityki, bez wyjątków dla konkretnego dostawcy.
- Poza zakresem: RBAC, konta administratorów w przeglądarce, wielodostępny SaaS z izolacją klientów, sandbox dla niezaufanego kodu, marketplace, automatyczne aktualizacje, nowe typy rozszerzeń SDK.
- Nie zmieniamy istniejących zasad custom webhooków ani uprawnień zwykłego API zadań. Zabezpieczamy jednak wszystkie drogi zmiany odbiorników należących do czatu.

## Granica zaufania

Administrator CLI to użytkownik systemowy posiadający dostęp do tej samej instalacji, `CEZ_HOME` i projektów co proces serwera. Nie używa root, jeśli serwer działa jako zwykły użytkownik. Niepoprawny użytkownik lub inny katalog stanu daje czytelny błąd, nie drugi niezależny bot.

Rozszerzenie działa jako użytkownik systemowy Cezara. Osobny worker izoluje awarie, nie złośliwy kod. Zgody ograniczają oficjalne API hosta, nie dostęp do plików i sieci systemu operacyjnego. CLI przedstawia ten fakt przed zatwierdzeniem.

Hosted nadal wymaga uwierzytelnionego reverse proxy lub tunelu. `CEZ_REMOTE=1` nie zapewnia logowania. Każdy użytkownik dopuszczony do danego cockpitu może korzystać z udostępnionych tam operacji projektu; specyfikacja nie tworzy rozróżnienia administrator/czytelnik w przeglądarce. Zatwierdzając rozszerzenie, administrator zatwierdza też udostępnienie jego komend i formularzy tym użytkownikom.

Komenda lub formularz rozszerzenia może wykonywać własne działania zewnętrzne. Nie obiecujemy, że każda komenda jest tylko do odczytu. Nadal obowiązuje obecny model propozycji zadań: standardowe API rozszerzeń proponuje zadanie, użytkownik przegląda je przed startem. Bot używa osobnej, już istniejącej ścieżki potwierdzania zadań.

## Macierz operacji

| Operacja | Local UI | Hosted UI / publiczne HTTP | CLI administratora |
| --- | --- | --- | --- |
| Instalacja, update, reload, uninstall | Jak obecnie | Odmowa | Tak |
| Zgoda na kod, wybór źródła adaptera, zmiana uprawnień | Jak obecnie | Odmowa | Tak |
| Enable, disable, review/retry | Jak obecnie | Odmowa | Tak |
| Globalny inventory, ścieżki źródeł, wpływ na inne projekty | Jak obecnie | Ukryte | Tak |
| Projektowa lista dopuszczonych funkcji i ich stan | Jak obecnie | Tak, ograniczony widok | Tak |
| Panele, komendy, formularze użytkowe | Jak obecnie | Tylko zatwierdzony projekt i artefakt | Nie wymagamy CLI do zwykłych paneli |
| Tokeny, setup, parowanie, odbiorcy, osoby i uprawnienia czatu | Jak obecnie | Odmowa zmian | Tak |
| Stan bota, nazwy rozmów i zredagowany błąd | Jak obecnie | Tak, projektowo | Tak |
| Diagnostyka administracyjna, kody parowania, lista przydziałów innych projektów | Jak obecnie | Ukryte | Tak |
| Odpowiedzi i polecenia przez komunikator | Obecne zgody | Niezależne od otwarcia UI | Osoby zatwierdzone przez administratora |

Odmowa musi działać po stronie serwera również dla ręcznego HTTP, aliasów tras i tras webhooków modyfikujących odbiorniki czatu. Ukrycie przycisku nie jest kontrolą dostępu. Formularz użytkowy nie może przez API hosta instalować kodu, zatwierdzać siebie, zmieniać źródła adaptera ani przyznawać uprawnień osobom.

## Zgoda hosted i zgodność stanu

Rozszerzamy istniejący zapis dostępu projektu o opcjonalną zgodę hosted: identyfikator rozszerzenia, dokładną integralność artefaktu, zatwierdzone permissions/capabilities oraz rewizję zgody. Model musi objąć zarówno installed, jak i shipped; jawny `origin` pozostaje źródłem informacji o pochodzeniu. Nie używamy timestampu jako znacznika zaufania.

Brak zgody oznacza brak prawa do wykonywania w hosted. Uszkodzona lub niedopasowana zgoda blokuje tylko dany dodatek; nie blokuje uruchomienia Cezara. Nie odtwarzamy zgód z manifestu ani z historii uruchomień. Utrata zgody nigdy nie przyznaje szerszego dostępu.

Nowy artefakt, także ta sama wersja z innymi bajtami, wymaga nowej zgody hosted. Dotyczy to reload, update, zmiany źródła i adaptera shipped zmienionego po aktualizacji Cezara. CLI pokazuje różnicę i może wykonać update oraz zatwierdzenie w jednym świadomie potwierdzonym przebiegu. Bez zatwierdzenia nowy kod nie uruchamia się w hosted; UI podaje przyczynę. Nie zmieniamy łagodniejszej dotychczasowej polityki lokalnych aktualizacji.

Zgoda hosted i wybór wersji adaptera muszą wskazywać ten sam artefakt. Zachowujemy obecne przypięcie wybranego adaptera oraz jawny powrót do shipped; uninstall lub awaria nie przełącza implementacji automatycznie.

Przejście local → hosted nie przenosi automatycznie istniejących osób uprawnionych do sterowania. CLI pokazuje istniejące połączenia, odbiorców i granty, a administrator jawnie zatwierdza ich wykorzystanie w hosted. Przebieg ponownie wykorzystuje dowód parowania, jeśli nadal jest ważny według reguł domenowych; nie wymaga bez powodu nowego bota. Zmiana lokalnego zestawu uprawnień nie rozszerza automatycznie zatwierdzonego zakresu hosted.

Rewizje wiążą zgodę z podglądem. Jeśli artefakt, grant, odbiorca lub wybór adaptera zmienił się w trakcie decyzji, operacja odmawia i wymaga nowego podglądu. Zapis atomowy i istniejące blokady są obowiązkowe. Schematy magazynu zachowują dane nieznane starszej wersji tam, gdzie przewiduje to polityka repozytorium; stary Cezar nadal blokuje hosted, zamiast interpretować brak obsługi jako zgodę.

## Ogólne operacje CLI

CLI udostępnia listę i status, podgląd instalacji, instalację, zatwierdzenie dla projektu hosted, wyłączenie, aktualizację/reload, ponowienie po awarii i odinstalowanie z obecną semantyką danych. Nazwy subkomend zostaną ustalone podczas implementacji; nie są przedmiotem tej specyfikacji.

CLI używa istniejących usług domenowych, nie powiela instalatora ani logiki zgód. Przed mutacją pokazuje projekt, dokładny artefakt, źródło i skutki dla projektów. Instalacja nie oznacza zatwierdzenia ani uruchomienia. Zgoda hosted jest osobną, świadomą decyzją. Wyłączenie dostępu hosted nie usuwa zgody lokalnej.

Nie wymagamy ręcznej edycji konfiguracji. Odczyty mogą mieć stabilny format JSON bez sekretów. Jeśli operacja wymaga sekretu, nie przekazujemy go w argumentach procesu ani nie zapisujemy w historii lub logach. Sposób konfiguracji konkretnej usługi i jej kreator pozostają odrębnym zagadnieniem.

## Transport administracyjny i jeden właściciel runtime

CLI nie może uzyskiwać uprawnień administracyjnych przez publiczne HTTP tylko dlatego, że podaje specjalny nagłówek albo łączy się z localhost. Reverse proxy również łączy się lokalnie.

Wybieramy prywatne IPC do działającego procesu Cezara: Unix domain socket w prywatnym katalogu `cezarHomeDir()` (katalog 0700, socket 0600), na Windows named pipe z ACL ograniczoną do użytkownika serwera. IPC nie jest proxyowane, nie ma portu TCP i nie pojawia się pod `/api/v1`. Listener jest tworzony tylko dla procesu z dopuszczonym administracyjnym CLI i używa walidowanych, zamkniętych typów operacji, nie dowolnego wywołania metod. Implementacja musi sprawdzić własność i typ ścieżki, odrzucać dowiązania i nie usuwać aktywnego socketu drugiego procesu. Brak możliwości ustanowienia prywatnego IPC wyłącza zarządzanie CLI, nie boot serwera; żadnego awaryjnego przejścia na HTTP.

CLI automatycznie odnajduje właściwy serwer dla projektu. Rejestracja endpointu zawiera identyfikator instancji i wersję protokołu; nieaktualny wpis daje błąd z instrukcją uruchomienia Cezara. Przy wielu kandydatach CLI wymaga wskazania instancji, nie wybiera pierwszej. Zapis ani brak pliku discovery nie jest sam w sobie dowodem tożsamości serwera.

W V1 wszystkie mutacje administracyjne wymagają działającego właściciela projektu. Nie tworzymy drugiego tymczasowego runtime i nie edytujemy stanu żywego serwera z CLI. Serwer wykonuje mutacje pod istniejącymi blokadami, aktualizuje stan i runtime, a CLI czeka na rzeczywisty wynik. Instalator nie uruchamia kodu przed zatwierdzeniem. Długie operacje mają osobny identyfikator i odczyt statusu zamiast bezterminowego RPC.

Zamknięcie CLI/SIGINT zwalnia zasoby oczekiwania. Nie wyłącza wcześniej działającego rozszerzenia. Niedokończony podgląd wygasa; przerwanie klienta nie jest równoznaczne z cofnięciem już zatwierdzonej mutacji. Niepewny wynik mutacji odczytuje się po ID operacji; klient nie powtarza automatycznie skutków. Niezgodny protokół CLI/serwera daje instrukcję użycia zgodnej wersji.

## Rozszerzenia mające własne integracje

Zatwierdzenie kodu nie zastępuje konfiguracji połączenia ani dostępu osoby w zewnętrznym systemie. Każdy typ rozszerzenia zachowuje istniejące reguły domenowe: potwierdzenia, granty, sekrety, własność połączeń i ograniczenia dostarczania zdarzeń.

Operacje zwiększające dostęp pozostają dostępne tylko przez administracyjny interfejs lokalny. Publiczne HTTP nie może obejść tej zasady przez formularz konfiguracji, trasę odbiornika ani bezpośrednie wywołanie providera. Istniejący lokalny zakres dostępu wymaga jawnego dopuszczenia do hosted; nie trzeba przy tym bez powodu odtwarzać ważnej konfiguracji.

Obecne bezwarunkowe blokady hosted w usługach takich rozszerzeń zastępujemy wspólną polityką wykonywania i właściwymi kontrolami domenowymi. Nie wymuszamy `mode: local` w celu ich obejścia. Szczegółowe kreatory konkretnych integracji mogą powstać w osobnych specyfikacjach; nie są warunkiem udostępnienia ogólnych paneli, komend i formularzy.

## Runtime, flagi i wyjścia ze stanów

Oddzielamy trzy pytania: czy wolno wykonywać kod, czy wolno używać funkcji w projekcie, czy wolno nimi administrować. `localHandoff` nie jest zastępczym uprawnieniem do wszystkich trzech.

| Stan | Wejście | Wyjście |
| --- | --- | --- |
| Brak zgody hosted | Nowa instalacja, stary lokalny stan | CLI zatwierdza dokładny artefakt |
| Zatwierdzony, zatrzymany | Flaga off, projekt zamknięty, serwer zatrzymany | Flagi pozwalają i projekt zostaje otwarty |
| Starting | Przywracanie lub enable | Running albo błąd aktywacji → failed |
| Running | Udana aktywacja | Disable/revoke/update/close → drain; awaria → obecny ograniczony restart |
| Failed | Błąd startu lub wyczerpany budżet restartów | Jawne CLI retry po ponownym sprawdzeniu zgody |
| Wymaga ponownej zgody | Inny hash, źródło albo zakres dostępu | CLI zatwierdza lub przywraca dopuszczony artefakt |
| Missing | Brak wybranego kodu | Reinstall i wymagane zatwierdzenie albo jawna zmiana źródła |

`CEZ_EXTENSIONS=0` nadal blokuje installed. W hosted blokuje również nowe uruchamianie shipped adapterów; nie włączamy tam lokalnego wyjątku in-process facade. Lokalny fallback shipped działa jak wcześniej. `CEZ_WEBHOOKS=1` nadal jest wymagane dla czatu i jego powiadomień; `CEZ_CHAT_INBOUND=1` dodatkowo dla sterowania. Hosted approval nie zastępuje żadnej flagi. Brak flagi nie kasuje połączenia, danych ani zgody. Nie zmieniamy env przez kreator i nie wymagamy nowego `CEZ_*`.

Przy starcie serwera odtwarzamy projekty z aktywnym, zatwierdzonym rozszerzeniem hosted z istniejącego rejestru, bez czekania na otwarcie strony w przeglądarce. Używamy zwykłego właściciela projektu i istniejących ograniczeń zasobów, bez drugiego managera. W V1 aktywne zatwierdzenie hosted jest podstawą odtworzenia rozszerzenia; nie dodajemy nowej klasyfikacji manifestu. Nie otwieramy projektów bez aktywnych zatwierdzeń. Zamknięcie przeglądarki nie zwalnia właściciela pracy w tle. Niedostępny katalog jednego projektu nie zatrzymuje pozostałych; stan pokazuje przyczynę i daje ponowienie przez CLI.

Revoke/disable blokuje nowe operacje natychmiast po zatwierdzonym zapisie, unieważnia generację dostępu, przerywa sesje odbiorcze i kończy proces w istniejącym ograniczonym czasie. Sprawdzanie zgody musi występować także po await, przy publikowaniu providera, rollbacku i przed skutkiem zadania. Trwającego zewnętrznego skutku nie da się cofnąć; CLI uczciwie to komunikuje. Powrót do starszej wersji kodu nigdy nie przywraca cofniętych zgód, sekretów ani kursorów. Pozostają istniejące deduplikacja, limity, backoff i zasada niepowtarzania niepewnych skutków.

## HTTP, kontrakt i panel

`capabilities.extensions` nie może już znaczyć jednocześnie instalowania i używania. Zachowujemy kompatybilny sygnał używania oraz dodajemy odrębne capabilities administracji rozszerzeniami i czatem. Projektowy odczyt zwraca dokładne dozwolone funkcje i powód niedostępności. Globalny sygnał nie uprawnia do wywołania innego projektu.

Wszystkie nowe HTTP request/response są w `packages/contract`, typy przez `z.infer`, trasy łańcuchowane i walidowane middleware. Odmowa administracji w hosted to 409 z jednoznacznym kodem `managed_by_cli`; brak prawa wykonywania ma oddzielny kod i przyczynę. Wywołanie brakującego zasobu nie ujawnia danych innych projektów. Prywatny protokół CLI ma własne walidowane schematy w usłudze, nie w publicznym SDK.

Projektowy widok nie ujawnia globalnej listy instalacji, ścieżek lokalnych, rejestrów prywatnych, sekretów, przydziałów innych projektów ani globalnego uninstall-impact. Pokazuje nazwę, wersję, stan, wkłady i zredagowane błędy. Hosted Integrations pokazuje rozmowy potrzebne do identyfikacji połączenia, ale nie listę grantów ani historię prywatnych poleceń.

W Settings → Extensions hosted pokazuje zatwierdzone funkcje oraz komunikat „Zarządzane przez CLI na serwerze”. Usuwamy przyciski instalacji, enable/disable, update, reload, wyboru źródła i retry; przy błędzie jest instrukcja dla administratora. Sidebar, paleta i widok zadania działają jak lokalnie. Formularze użytkowe rozszerzenia działają w zatwierdzonym zakresie, natywne formularze administracji Cezarem pozostają zamknięte.

Hosted nie otwiera przeglądarkowego WebSocketu. Zmiany zgód i stanów docierają istniejącym uwierzytelnionym SSE oraz powodują projektowe unieważnienie cache. Po reconnect obowiązuje snapshot; odświeżenie strony też odtwarza prawdę. Nie przywracamy globalnej lawiny invalidacji przy każdym ticku zadania. Revoke usuwa wkłady z otwartego UI; serwer odmawia także opóźnionemu kliknięciu ze starego widoku.

## Mapa zmian w repozytorium

- `packages/cezar/src/index.ts`: wejścia CLI i pomoc; osobne małe moduły komend oraz prywatnego IPC.
- `server/capabilities.ts`, `server/extensions.ts`, `server/chat-routes.ts` i rodziny webhooków: oddzielenie runtime/use/admin i kompletne zamknięcie obejść HTTP.
- `extensions/project-runtime.ts`, `manager.ts`, magazyn zgód, wybór i rejestracja czatu: wspólna polityka, jeden właściciel, odtworzenie i zmiany zgody. Szczególnie usunąć założenie `mode: 'local'` z management ownera jako sposobu omijania polityki.
- `chat/availability.ts`, `host.ts`, `service.ts`, setup, bindings oraz `webhooks/service.ts`: zachowanie trybu hosted bez globalnej odmowy i bez pomijania uprawnień.
- Start/close projektów i serwera: odkrywanie dopuszczonych integracji bez otwarcia UI, zamknięcie IPC i workerów.
- `packages/contract` i api-client: capabilities, projektowe DTO, kody odmów, parity i typed bodies.
- `packages/web`: Settings/Integrations, panele, paleta, task view, SSE i komunikaty CLI.
- Dokumentacja użytkownika i autora, `docs/reference.md`, `BACKWARD_COMPATIBILITY.md`, `AGENTS.md`: nowe zasady hosted. `.env.example` aktualizujemy razem ze zmianą znaczenia istniejących flag; nowej flagi nie planujemy.

Przed implementacją należy przeszukać wszystkie konstrukcje `ChatHost`, `ChatService`, `ExtensionManager` i właścicieli projektów, nie tylko użycia pola `mode`. Dotyczy to boot, lazy open, restartu, kontynuacji oraz ścieżek zarządzania. Historyczna specyfikacja V1 zawiera nieaktualne szczegóły; źródłem zachowania lokalnego są obecny kod i jego testy.

## Etapy implementacji

1. Schematy zgody i capabilities, wspólna polityka, pełna macierz local/hosted/flags; bez otwierania publicznych tras administracyjnych.
2. Prywatne IPC i CLI administracji rozszerzeniami; spójność aktywnego właściciela, aktualizacji, rewizji i restartów.
3. Runtime hosted i projektowy HTTP do używania; przywracanie integracji bez przeglądarki i bez duplikacji procesów.
4. Zgodność istniejących rodzajów wkładów i usług domenowych ze wspólną polityką hosted; bez implementowania kreatorów konkretnych dostawców w tym zakresie.
5. UI hosted oraz SSE; brak przycisków i obejść administracji.
6. Dokumentacja, testy paczki i e2e oraz niezależny przegląd granicy CLI/HTTP przed wdrożeniem.

Etapy są zależne; nie dzielić jednej polityki autoryzacji między niezależne implementacje. Przegląd może być osobnym zadaniem, gdy powstanie gotowy diff. Ta specyfikacja nie upoważnia do konfiguracji produkcyjnego bota ani publikowania zmian.

## Kryteria akceptacji i weryfikacja

1. Domyślny local działa identycznie. Hosted bez zgody uruchamia zero adapterów/workerów, nie pobiera paczek i nie wysyła wiadomości, także ze starym lokalnym stanem.
2. CLI instaluje i zatwierdza dokładny artefakt dla projektu A. Panel A używa panelu, formularza i komendy; projekt B nie może ich wywołać. Sama instalacja nie uruchamia kodu.
3. Każda operacja administracyjna jest odrzucona przez publiczne HTTP, również przy localhost Host, nagłówku udającym CLI, aliasie trasy, starym froncie i przez receiver API. Brak side effect przed odmową.
4. Prywatne IPC odrzuca innego użytkownika, niezgodny protokół, nieprawidłowe ramki, złą tożsamość instancji oraz socket/discovery podmieniony dowiązaniem. Na wspieranych systemach sprawdzamy rzeczywiste uprawnienia, nie tylko mock.
5. Przykładowe rozszerzenie udostępnia panel, komendę, formularz i obsługę zdarzeń w hosted bez zmian w swoim kodzie ani SDK. Zdarzenia są obsługiwane również przy zamkniętej przeglądarce. Niedozwolone operacje hosta są odrzucane.
6. Powiadomienia bez inbound działają; inbound bez webhooks nie działa. `CEZ_EXTENSIONS=0` nie uruchamia hosted facade. Każda kombinacja flag ma test runtime, HTTP i capabilities.
7. Restart odtwarza zatwierdzone integracje bez żądania z przeglądarki. Wyłączone, uszkodzone, missing i niezatwierdzone projekty nie odzyskują dostępu. Brak jednego katalogu nie zatrzymuje serwera.
8. Aktualizacja/reload pod tym samym numerem z innym hashem nie uruchamia nowego kodu bez zgody. Wybrana wersja adaptera pozostaje przypięta. Cofnięcie zgody podczas drain/start/rollback nigdy nie wznawia workera.
9. Dwa równoległe CLI nie tracą zapisów i nie tworzą dwóch workerów dla tej samej pary projekt–rozszerzenie. Nieaktualny podgląd odmawia. SIGINT i restart nie pozostawiają blokad ani nie unieważniają niezależnych zatwierdzonych operacji.
10. Revoke podczas oczekiwania na przycisk/komendę odmawia skutku. Sekrety i kody parowania nie trafiają do publicznych odpowiedzi, argv, logów, SSE ani wyników komend.
11. Hosted UI aktualizuje sidebar/paletę/task view przez SSE, nie otwiera WS, nie odpytuje bez końca zamkniętych widoków i nie unieważnia globalnie wszystkich danych na zmianę runu.
12. CLI uninstall zachowuje obecną semantykę keep-data/remove-data/Missing oraz zależności odbiorników. Usunięcie kodu nie przywraca automatycznie shipped.
13. Przykładowy provider z istniejącą konfiguracją testową działa według tej samej polityki co pozostałe wkłady. Zatwierdzenie kodu nie omija jego kontroli domenowych. Brak zmian ABI SDK bez osobnego uzasadnienia.
14. Testy jednostkowe polityki, rzeczywista integracja IPC/CLI, contract parity, typed bodies, test spakowanego CLI oraz e2e dwóch powierzchni (local/hosted) są wymagane. Usługi komunikatorów w testach są lokalnymi fixture'ami; rzeczywiste konta nie są wymagane przez CI.
15. Każdy test zabezpieczający nową granicę ma kontrolę negatywną: po celowym pominięciu bramki test musi przestać przechodzić. Zachowujemy testy zgodności local. Końcowe bramki: typecheck, build/check:pack, właściwe pełne suity repozytorium, test:unit, test:package, e2e i dokumentacja. Nie deklarujemy zgodności Windows bez sprawdzenia named pipe/ACL.

## Warunek ukończenia

Administrator instaluje i zatwierdza rozszerzenie dla projektu hosted przez CLI. Użytkownik korzysta z jego wkładów w panelu. Praca w tle wraca po restarcie bez otwierania przeglądarki. Publiczne HTTP nie daje administracyjnego dostępu do kodu ani zgód, a local zachowuje dotychczasowe działanie. Instrukcja użytkownika opisuje ogólne operacje CLI rzeczywiście dostarczone w paczce.
