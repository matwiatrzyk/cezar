# Integrations — lokalna propozycja

Galeria konkretnych narzędzi zastępuje osobne pozycje „Issue tracker” i „External integrations”. Jira i TesterArmy działają obok siebie. Kliknięcie kafelka otwiera panel z prawej strony, zachowując kontekst galerii. To propozycja do oceny, nie wdrożenie w aplikacji.

Otwórz `index.html` w przeglądarce. Plik korzysta wyłącznie z lokalnych zasobów repozytorium. Dane są fikcyjne; zmiany formularzy trwają do odświeżenia strony. Nic nie jest wysyłane, instalowane ani zapisywane do konfiguracji projektu. Nie wpisuj prawdziwych kluczy.

## Dlaczego ten układ

Znane z kodu: `registry.tsx` rozdziela tracker i integracje; `tracker-section.tsx` obsługuje Jirę i Linear, ale jedną konfigurację źródła zgłoszeń na projekt; `tester-army-e2e-card.tsx` wykrywa instalację, konfigurację i workflow. Nie należy przedstawiać instalacji TesterArmy jako połączenia z kontem zewnętrznym.

[ASSUMPTION] Rozpoznanie narzędzia po nazwie i wejście bezpośrednio do jego ustawień ułatwi odnalezienie konfiguracji. Kafelki pokazują „Connected”, „Installed” lub „Not connected”; status nie zależy wyłącznie od koloru. Galeria z panelem wymaga mniej przełączania kontekstu niż osobne strony narzędzi; wspólny długi formularz utrudniałby odróżnienie ustawień poszczególnych usług. Przy trzech narzędziach pomijamy wyszukiwarkę i filtry.

Nie ma `.uxproof/` w tym checkoutcie. Kolory, font i ogólny szkielet zaczerpnięto z istniejących plików UI, bez twierdzenia o pełnej zgodności z kontraktem projektu.

## Zakres i przebieg

Teraz: interaktywna makieta desktop/mobile, galeria, panele Jira i TesterArmy, informacyjny panel Linear, symulowane sprawdzenie połączenia, błędu i braku uprawnień. „Save changes” zmienia tylko dane w pamięci makiety; „Cancel”, zamknięcie i Escape odrzucają edycję.

Później: implementacja w istniejących komponentach React, rzeczywiste operacje API, stany instalacji i odłączenia. Makieta nie dodaje obsługi wielu trackerów jednocześnie; obecne ograniczenie źródła zgłoszeń jest ujawnione w panelu Linear i nie obejmuje narzędzi testowych.

Nie robimy: zmian serwera, prawdziwego podłączania kont, instalacji testów, publikacji ani zmiany nawigacji aplikacji.

## Ekrany i komunikaty

- Galeria: „In use” z Jira „Connected” oraz TesterArmy „Installed”; „Available” z Linear „Not connected”. Akcja „Configure” otwiera panel narzędzia.
- Jira: „Jira site URL”, „Account email”, „API token”, „Jira project”; „Test connection” i „Save changes”. Pusty token oznacza zachowanie zapisanego tokena w projektowanym produkcie; makieta nie zapisuje tokenów.
- TesterArmy: „Project setup”, lista konfiguracji i workflow, „Model provider”, opcjonalny „Model API key”, „Check setup”.
- Podczas sprawdzania: „Checking connection…” / „Checking project setup…”; przyciski sprawdzania i zapisu są chwilowo nieaktywne.
- Sukces: „Connection verified. CEZ project is accessible.” / „Setup is ready. Configuration and workflow found.” W makiecie dopisek „(Demo)”.
- Błąd: „Could not complete the check. Your saved settings are unchanged. Try again.” Akcja „Try again” zachowuje wpisane dane.
- Uprawnienia: „Access denied. Check the account permissions, then try again.”
- Linear: wyjaśnienie, że zmiana źródła zgłoszeń zastąpi Jirę, a TesterArmy pozostanie zainstalowane. Brak aktywnej operacji zastąpienia w makiecie.
- Przed wdrożeniem należy też obsłużyć brak danych („No integrations configured”), pobieranie statusów („Loading integrations…”), nieznany status („Status unavailable” + „Retry”), instalację w toku i oczekiwanie na merge. Brak odpowiedzi API nie może być interpretowany jako „Not connected”. Te widoki nie są symulowane w tej makiecie.

Panel korzysta z natywnego `dialog` z nazwą, blokadą fokusu w modalu i zamykaniem Escape. Formularze mają etykiety, widoczny fokus i region statusu. Na telefonie panel wypełnia szerokość ekranu, a kafelki tworzą jedną kolumnę. Pozostała nawigacja jest nieruchomym kontekstem makiety.

## Co sprawdzić z użytkownikiem

Najważniejsze niepotwierdzone założenie: rozdzielenie „In use” i „Available” oraz panel boczny przyspiesza odnajdywanie konfiguracji. Poprosić użytkownika o znalezienie projektu Jira i zmianę dostawcy modelu TesterArmy bez podpowiedzi; obserwować ukończenie i błędne wejścia. Jeśli nie odróżnia instalacji od połączenia, doprecyzować opisy statusów; jeśli gubi kontekst w panelu, porównać z osobną stroną szczegółów. Potencjalna korzyść: mniej pomocy przy konfiguracji. Warunek: edycja jednego narzędzia nie zmienia ustawień drugiego.

## Źródło metody

Użyto `om-ux-shape` (Shape, mały zakres): https://github.com/open-mercato/skills/blob/main/skills/om-ux-shape/SKILL.md oraz wskazanych referencji. Skill posłużył do decyzji i opisu; HTML jest osobną makietą przygotowaną na prośbę użytkownika. Nie instalowano skilla globalnie.

## Weryfikacja makiety

Uruchomiono `TMPDIR=/tmp node /tmp/cezar-integrations-preview.mjs` na lokalnym Chromium: PASS — trzy panele, sprawdzenie sukcesu/błędu/uprawnień, Escape, zapis w pamięci, brak poziomego przepełnienia przy 1440/390 px i brak błędów JavaScript. Obejrzano zrzuty galerii i konfiguracji Jira. Nie testowano prawdziwych usług ani produkcyjnej aplikacji. Zrzuty: `gallery-desktop.png`, `jira-configuration.png`, `testerarmy-configuration.png`, `gallery-mobile.png`, `jira-mobile.png`.
