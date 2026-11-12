# System rozszerzeń Cezara — projekt

Status: zrealizowane V1 (2026-11-06) — instalacja z npm i z lokalnego katalogu, zgody, komendy, panele, formularze/ustawienia, zdarzenia zadań i adaptery komunikatorów; publiczne SDK `@open-mercato/cezar-extension-sdk` w zestawie wydania. Opis użytkownika: `docs/site/content/docs/03-features/settings-and-projects/extensions.mdx`; autora: `docs/authoring-extensions.md`. Ograniczenie V1 (panele, komendy i formularze tylko w Ustawienia → Extensions) znosi `2026-11-07-extension-placements-v1.1.md`. Ustalenia użytkownika: system możliwie uniwersalny, pierwsi autorzy to nasz zespół, instalacja paczki oraz lokalnego katalogu. Marketplace nie jest potrzebny na start.

## Cel i granice

Autor tworzy osobny projekt, korzysta z publicznego SDK, dodaje manifest i publikuje paczkę. Użytkownik instaluje ją w Cezarze bez przebudowy aplikacji. Także nasz zespół może dostarczać funkcje tą drogą.

Uniwersalność oznacza wspólny mechanizm instalacji, cyklu życia, uprawnień, danych i wersjonowania oraz kilka jawnych punktów rozszerzeń. Nie oznacza prawa do podmieniania dowolnego kodu Cezara. Dodanie nowego rodzaju rozszerzenia wymaga rozszerzenia API hosta; nowy dostawca obsługiwanego rodzaju już nie.

V1 udostępnia komendy/akcje użytkownika, deklaratywne panele i ustawienia, zdarzenia zadań oraz adaptery komunikatorów. Kolejne etapy dodają trackery i backendy agentów. Publiczne API tych dwóch kategorii powstaje dopiero po ich migracji i testach zgodności — nie obiecujemy go w pierwszym wydaniu.

Poza zakresem: marketplace, płatności, automatyczne aktualizacje, dowolny React/HTML w głównej aplikacji, wtyczki modyfikujące rdzeń, bezpieczne uruchamianie niezaufanego kodu. Natywne slash commands Discorda nie są punktem rozszerzeń — wbudowany dostawca Discord obsługuje je natywnie (`chat/providers/discord/native-commands.ts`).

## Stan repozytorium

- `chat/provider.ts` i `chat/registry.ts` mają wewnętrzne interfejsy i statyczny rejestr; formaty i identyfikatory dostawców są częściowo zamknięte w kontraktach.
- `docs/adding-chat-provider.md` wymaga obecnie zmian także w kontrakcie, trasach, usługach i frontendzie. Sam dynamiczny import nie wystarczy.
- `docs/adding-issue-tracker.md` opisuje osobny wewnętrzny interfejs; `core/runner-factory.ts` statycznie tworzy backendy agentów.
- `routes/settings/registry.tsx` rozdziela ustawienia globalne i projektowe. Instalacja dodatku jest globalna, jego dostęp do projektu — projektowy.
- Publiczne SDK musi być samodzielnie publikowalne. Dzisiejsze prywatne `contract` i `api-client` nie mogą stać się nierozwiązywalnymi zależnościami paczki autora.

Po akceptacji niniejszy projekt zastępuje zakaz zewnętrznego loadera/SDK w `.ai/specs/2026-11-04-chat-providers.md` wyłącznie w zakresie nowego systemu. Dotychczasowe gwarancje parowania, zgód, deduplikacji i dostarczania wiadomości pozostają obowiązujące.

## Wybrana architektura

Rozważone warianty: dynamiczny import w serwerze jest prosty, ale łączy awarie i zależności; osobny proces z jawnym protokołem daje kontrolę cyklu życia; pełny sandbox to osobny, znacznie większy projekt. Wybieramy osobny proces dla aktywnej pary wtyczka–projekt i walidowane RPC przez IPC Node. Komendy, dane paneli i wywołania hosta przechodzą przez ten protokół. Proces nie dostaje obiektów `RunManager`, magazynu sekretów ani kontekstu Hono.

**To izolacja awarii, nie sandbox bezpieczeństwa.** Kod Node uruchomiony jako użytkownik może sam sięgać do plików i sieci. V1 instaluje wyłącznie kod zaufany przez użytkownika; uprawnienia ograniczają oficjalne API Cezara, nie możliwości systemu operacyjnego. UI musi jasno to mówić. Nie obiecujemy bezpieczeństwa wobec złośliwego autora.

Zestaw bazowy SDK: `defineExtension`, `ExtensionContext`, `Disposable`, rejestracja komend, paneli i formularzy, projektowy magazyn danych, logger z redakcją, subskrypcje zdarzeń oraz kontrolowane operacje na zadaniach. Osobne moduły `chat`, później `tracker` i `runner`, mają własne interfejsy i zestawy testów zgodności.

SDK: nowy publikowalny pakiet `@open-mercato/cezar-extension-sdk`, API początkowo `0.1`. W tej fazie host akceptuje wyłącznie jawnie obsługiwaną linię `0.1.x`; nie udajemy stabilności całego 0.x. Po pilotażu stabilizujemy 1.0. Nieznane obowiązkowe możliwości powodują odmowę aktywacji, nie ciche pominięcie.

## Manifest i kontrakt

Plik `cezar-extension.json` w paczce, przykładowo:

```json
{
  "schemaVersion": 1,
  "id": "open-mercato.project-summary",
  "name": "Project summary",
  "version": "0.1.0",
  "apiVersion": "0.1",
  "main": "dist/index.js",
  "capabilities": ["commands", "panels", "taskEvents"],
  "permissions": ["tasks.read"],
  "contributes": {
    "commands": [{ "id": "refresh", "title": "Refresh summary" }],
    "panels": [{ "id": "summary", "title": "Project summary" }]
  }
}
```

Manifest i komunikaty mają pojedyncze schematy Zod oraz typy z nich wywnioskowane. SDK jest właścicielem wspólnego protokołu; HTTP contract importuje/reeksportuje jego Node-free schematy, nie duplikuje ich. Ustalić bundlowanie SDK w artefakcie serwera, aby instalacja Cezara nie zależała od kolejności publikacji paczek.

Identyfikatory wkładów są kwalifikowane identyfikatorem wtyczki. Rejestracja musi odpowiadać manifestowi. Zakaz nadpisywania identyfikatorów rdzenia i innych wtyczek. Schemat formularzy to ograniczony opis pól, nie wykonywalny kod walidatora. Panele: tekst, statusy, listy/tabele, pola i przyciski renderowane istniejącymi komponentami. Bez arbitralnego HTML i skryptów.

## Ścieżka użytkownika

1. Settings → Extensions → Install extension → Package / Local folder.
2. Paczka: nazwa z opcjonalną wersją; katalog: wybór folderu z manifestem i już zbudowanym JS. Nie wymagamy edycji plików konfiguracji.
3. Podgląd: nazwa, dokładna wersja, źródło, deklarowane możliwości, dostęp do danych i informacja o uruchamianiu zaufanego kodu lokalnie. Instalacja nie uruchamia kodu dodatku.
4. Enable for project: wybór projektu i zatwierdzenie potrzebnego dostępu. Potem ewentualny formularz połączenia, np. z komunikatorem. Instalacja paczki nie zastępuje zgody na połączenie z platformą.
5. Lista pokazuje wersję, projekty, stan, błąd z możliwością naprawy oraz Disable / Update / Uninstall. Tryb katalogu ma Reload. Brak automatycznego włączania w nowych projektach.

Integrations pozostaje miejscem podłączania usług; Extensions zarządza oprogramowaniem. Dodatek komunikatora dostarcza kafelek do Integrations. Nie powielamy kreatora połączenia w Extensions.

## Instalacja, dane, cykl życia

- Wersję paczki rozwiązujemy do konkretnego artefaktu, zapisujemy integralność i drzewo zależności. Instalacja w stagingu poza repozytorium, bez skryptów lifecycle i bez shellowej interpolacji argumentów. W V1 przyjmujemy paczki rejestru npm oraz lokalne katalogi, nie dowolne Git/URL/tarball wskazane przez użytkownika. Odrzucamy wyjście ścieżek i dowiązań poza katalog paczki. Zależności wymagające skryptów instalacyjnych są nieobsługiwane z czytelnym błędem.
- Rejestr i artefakty pod `cezarHomeDir()/extensions/`; zapis atomowy, blokada między procesami. Stan projektu izolowany przez `projectId` i `extensionId`. Uszkodzony wpis wyłącza tylko ten dodatek. Brak dodatków = brak procesów, pobrań i zmian zachowania rdzenia.
- Stany: installed/disabled → starting → running; błąd lub śmierć procesu → failed. Restart tylko jawny; bez nieskończonej pętli. Disable blokuje nowe wywołania, unieważnia generację uprawnień, przerywa oczekujące operacje, sprząta rejestracje, a po terminie kończy własny proces. Stop ma 5 s, start 10 s; żądania bazowego RPC 30 s, limit ramki 1 MiB i 100 oczekujących wywołań. Strumienie runnerów mają osobny protokół, nie zwiększają tego timeoutu globalnie.
- Update: staging i walidacja → zatrzymanie starej wersji → aktywacja nowej. Błąd przywraca kod i snapshot stanu wtyczki. Zewnętrznych efektów nie da się cofnąć: migracje danych są lokalne, bez wywołań platform. Nowe uprawnienia wymagają ponownej zgody.
- Uninstall domyślnie zachowuje konfigurację i dane do ponownej instalacji; osobna, jawna opcja usuwa dane i sekrety należące do dodatku oraz wiersz zgody projektu (inaczej widoczny jako Missing), chyba że wybór czatu lub odbiornik webhooków wciąż wskazuje dodatek — wtedy wiersz zostaje, a podgląd uninstall mówi dlaczego. Nie usuwa historii zadań ani rekordów wspólnych. Wyłączony provider pozostaje rozpoznawalny w historycznych danych.
- Wbudowane funkcje są dostarczone razem z Cezarem i działają bez instalowania czegokolwiek. Migracja adaptera zachowuje dotychczasowy stan i identyfikatory; nie wymusza ponownego parowania.

## Dostęp i zdarzenia

Host sam ustala projekt i właściciela wywołania z sesji IPC; nie ufa `projectId` z payloadu. Operacje mutujące zadania przechodzą przez obecne reguły potwierdzeń, limitów i uprawnień. W V1 komenda może zaproponować zadanie w istniejącym formularzu; nie dostaje ogólnego `startRun` bez kontroli.

Sekrety dostępne wyłącznie w przestrzeni danego dodatku i projektu, przez istniejące szyfrowanie, nigdy przez API do frontendu lub środowisko agentów. Proces dostaje minimalne środowisko uruchomieniowe, bez dziedziczenia tokenów hosta. Jest to ograniczenie przypadkowych wycieków, nie sandbox.

Zdarzenia paneli to aktualizacje informacyjne, bez gwarancji trwałego doręczenia; po restarcie panel odczytuje snapshot. Nie wolno na nich opierać automatycznego uruchamiania zadań. Przy przepełnieniu ograniczonej kolejki host wysyła `resyncRequired`. Integracje czatu zachowują istniejący trwały dziennik i zasady niepowtarzania niepewnych efektów. Każda subskrypcja ma właściciela i dispose; globalny UI korzysta ze wspólnego WS, z dotychczasowym fallbackiem trybu remote.

## Warunek powodzenia

Zewnętrzny projekt z samym publicznym SDK buduje działającą wtyczkę bez importów z wnętrza repo. Instalujemy i wyłączamy ją przez UI bez restartu Cezara. Pokazujemy dwa różne zastosowania: panel podsumowania projektu z akcją oraz komunikator. Awaria, aktualizacja lub usunięcie jednego dodatku nie psuje podstawowej pracy ani drugiego dodatku. Dopiero ten wynik uznajemy za gotowe V1, a nie samo istnienie loadera.
