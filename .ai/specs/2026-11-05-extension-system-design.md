# System rozszerzeń Cezara — projekt

Status: zrealizowane, jeszcze niewydane (zakres: instalacja z npm
i z lokalnego katalogu, zgody, komendy, panele, formularze/ustawienia, zdarzenia zadań i adaptery
komunikatorów; publiczne SDK `@open-mercato/cezar-extension-sdk` w zestawie wydania). Miejsca
wpięcia poza Settings → Extensions: `2026-11-07-extension-placements.md`. Adaptery
Telegram/Slack/Discord jako zwykłe rozszerzenia: `2026-11-09-independent-chat-plugins.md`. Tryb
hosted: `2026-11-12-hosted-extensions.md`. Opis użytkownika:
`docs/site/content/docs/03-features/settings-and-projects/extensions.mdx`; autora:
`docs/authoring-extensions.md`.

## Cel i granice

Autor tworzy osobny projekt, korzysta z publicznego SDK, dodaje manifest i publikuje paczkę.
Użytkownik instaluje ją w Cezarze bez przebudowy aplikacji. Także nasz zespół dostarcza funkcje tą
drogą. Pierwsi autorzy to nasz zespół; marketplace nie jest potrzebny.

Uniwersalność oznacza wspólny mechanizm instalacji, cyklu życia, uprawnień, danych i wersjonowania
oraz kilka jawnych punktów rozszerzeń. Nie oznacza prawa do podmieniania dowolnego kodu Cezara.
Dodanie nowego rodzaju rozszerzenia wymaga rozszerzenia API hosta; nowy dostawca obsługiwanego
rodzaju już nie.

System udostępnia komendy/akcje użytkownika, deklaratywne panele i ustawienia, zdarzenia zadań oraz
adaptery komunikatorów. Trackery i backendy agentów nie mają publicznego API; powstanie ono
dopiero po przeniesieniu ich na wspólny interfejs i testach zgodności.

Poza zakresem: marketplace, płatności, automatyczne aktualizacje, dowolny React/HTML w głównej
aplikacji, wtyczki modyfikujące rdzeń, bezpieczne uruchamianie niezaufanego kodu. Natywne slash
commands Discorda nie są punktem rozszerzeń — obsługuje je adapter Discord
(`packages/chat-plugins/discord/src/native-commands.ts`).

## Wybrana architektura

Rozważone warianty: dynamiczny import w serwerze jest prosty, ale łączy awarie i zależności;
osobny proces z jawnym protokołem daje kontrolę cyklu życia; pełny sandbox to osobny, znacznie
większy projekt. Wybieramy osobny proces Node dla aktywnej pary wtyczka–projekt i walidowane RPC
w ramkach liniowych na stdio (`extensions/worker-process.ts`, `extensions/protocol.ts`). Komendy,
dane paneli i wywołania hosta przechodzą przez ten protokół. Proces nie dostaje obiektów
`RunManager`, magazynu sekretów ani kontekstu Hono.

**To izolacja awarii, nie sandbox bezpieczeństwa.** Kod Node uruchomiony jako użytkownik może sam
sięgać do plików i sieci. Instalujemy wyłącznie kod zaufany przez użytkownika; uprawnienia
ograniczają oficjalne API Cezara, nie możliwości systemu operacyjnego. UI mówi to jasno. Nie
obiecujemy bezpieczeństwa wobec złośliwego autora.

Zestaw bazowy SDK: `defineExtension`, `ExtensionContext`, `Disposable`, rejestracja komend, paneli
i formularzy, projektowy magazyn danych, logger z redakcją, subskrypcje zdarzeń oraz kontrolowane
operacje na zadaniach. Moduł `chat` ma własny interfejs (`ExtensionChatAdapter`) i zestaw testów
zgodności.

SDK to publikowalny pakiet `@open-mercato/cezar-extension-sdk`, API `0.1`. Host akceptuje
wyłącznie jawnie obsługiwaną linię `0.1`; nie udajemy stabilności całego 0.x. Wewnątrz `0.1`
dozwolone są tylko zmiany addytywne (BACKWARD_COMPATIBILITY.md §6b); stabilizacja to 1.0.
Nieznane obowiązkowe możliwości powodują odmowę aktywacji, nie ciche pominięcie.

## Manifest i kontrakt

Plik `cezar-extension.json` w paczce, przykładowo:

```json
{
  "id": "open-mercato.project-summary",
  "name": "Project summary",
  "version": "0.1.0",
  "apiVersion": "0.1",
  "entry": "dist/index.js",
  "capabilities": ["commands", "panels", "taskEvents"],
  "permissions": ["project.read"],
  "contributes": {
    "commands": [{ "id": "refresh", "label": "Refresh summary" }],
    "panels": [{ "id": "summary", "title": "Project summary" }]
  }
}
```

Uprawnienia to `project.read` i `task.create`. Manifest i komunikaty mają pojedyncze schematy Zod
oraz typy z nich wywnioskowane (`packages/extension-sdk/src/schemas.ts`). SDK jest właścicielem
wspólnych schematów; kontrakt HTTP reeksportuje je (eksport `./source`), nie duplikuje. Ramki IPC
żyją w `packages/cezar/src/extensions/protocol.ts`, nigdy w SDK ani w kontrakcie HTTP. SDK jest
publikowane w zestawie wydania przed kontraktem, więc instalacja Cezara nie zależy od kolejności
publikacji.

Identyfikatory wkładów są kwalifikowane identyfikatorem wtyczki. Rejestracja musi odpowiadać
manifestowi. Nie wolno nadpisywać identyfikatorów rdzenia ani innych wtyczek. Schemat formularzy
to ograniczony opis pól, nie wykonywalny kod walidatora. Panele: tekst, statusy, tabele i
przyciski renderowane istniejącymi komponentami. Bez arbitralnego HTML i skryptów.

## Ścieżka użytkownika

1. Settings → Extensions → Install extension → Package / Local folder.
2. Paczka: nazwa z opcjonalną wersją; katalog: folder z manifestem i już zbudowanym JS. Nie
   wymagamy edycji plików konfiguracji.
3. Podgląd: nazwa, dokładna wersja, źródło, deklarowane możliwości, dostęp do danych i informacja
   o uruchamianiu zaufanego kodu lokalnie. Instalacja nie uruchamia kodu dodatku.
4. Enable for project: wybór projektu i zatwierdzenie potrzebnego dostępu. Potem ewentualny
   formularz połączenia, np. z komunikatorem. Instalacja paczki nie zastępuje zgody na połączenie
   z platformą.
5. Lista pokazuje wersję, projekty, stan, błąd z możliwością naprawy oraz Disable / Update /
   Uninstall. Tryb katalogu ma Reload. Nowe projekty nie włączają dodatków automatycznie.

Integrations pozostaje miejscem podłączania usług; Extensions zarządza oprogramowaniem. Dodatek
komunikatora dostarcza kafelek do Integrations. Kreator połączenia nie jest powielany w
Extensions.

## Instalacja, dane, cykl życia

- Wersję paczki rozwiązujemy do konkretnego artefaktu, zapisujemy integralność i drzewo
  zależności (zależności muszą mieć przypiętą integralność). Instalacja w stagingu poza
  repozytorium, bez skryptów lifecycle i bez shellowej interpolacji argumentów. Źródła: paczki
  rejestru npm oraz lokalne katalogi; nie dowolne Git/URL/tarball wskazane przez użytkownika.
  Odrzucamy wyjście ścieżek i dowiązań poza katalog paczki. Zależności wymagające skryptów
  instalacyjnych są odrzucane z czytelnym błędem.
- Instalacje są globalne i niezmienne: `cezarHomeDir()/extensions/artifacts/<id>/<version>/<digest>/`;
  zapis atomowy, blokada między procesami. Zgoda jest per projekt i wiąże dokładny artefakt; stan
  projektu izolowany przez `projectId` i `extensionId`. Uszkodzony wpis wyłącza tylko ten dodatek.
  Brak dodatków = brak procesów, pobrań i zmian zachowania rdzenia.
- Stany: installed/disabled → starting → running; błąd → failed. Nieudana aktywacja zostaje
  widocznie `failed`. Śmierć procesu po aktywacji daje restart z ograniczonym backoffem
  (`RestartBudget`: domyślnie 3 szybkie awarie, backoff od 1 s, podwajany), potem `failed`; bez
  nieskończonej pętli. Disable blokuje nowe wywołania, unieważnia generację uprawnień, przerywa
  oczekujące operacje, sprząta rejestracje, a po terminie kończy proces. Limity: start 10 s,
  stop 5 s, żądanie RPC 30 s, ramka 1 MiB, 100 oczekujących wywołań, magazyn danych ≤1000 kluczy
  i 4 MiB.
- Update: staging i walidacja → zatrzymanie starej wersji → aktywacja nowej. Błąd przywraca kod i
  snapshot stanu wtyczki. Zewnętrznych efektów nie da się cofnąć: migracje danych są lokalne, bez
  wywołań platform. Zmiana istotna dla zgody (uprawnienia, możliwości, źródło) wymaga ponownej
  zgody.
- Uninstall domyślnie zachowuje konfigurację i dane do ponownej instalacji; osobna, jawna opcja
  usuwa dane i sekrety należące do dodatku oraz wiersz zgody projektu (inaczej widoczny jako
  Missing), chyba że wybór czatu lub odbiornik webhooków wciąż wskazuje dodatek — wtedy wiersz
  zostaje, a podgląd uninstall mówi dlaczego. Nie usuwa historii zadań ani rekordów wspólnych.
  Wyłączony provider pozostaje rozpoznawalny w historycznych danych.
- Funkcje dostarczone z Cezarem działają bez instalowania czegokolwiek. Dostarczane adaptery
  komunikatorów zachowują identyfikatory providerów i stan odbiorców, bez ponownego parowania.

## Dostęp i zdarzenia

Host sam ustala projekt i właściciela wywołania z sesji workera; nie ufa `projectId` z payloadu.
Operacje mutujące zadania przechodzą przez reguły potwierdzeń, limitów i uprawnień. Komenda może
zaproponować zadanie (`tasks.propose`, uprawnienie `task.create`) w istniejącym formularzu; nie
dostaje ogólnego `startRun` bez kontroli.

Sekrety dostępne wyłącznie w przestrzeni danego dodatku i projektu, przez szyfrowany vault
projektu, nigdy przez API do frontendu ani środowisko agentów; wyniki wywołań hosta mają
zredagowane sekrety. Proces dostaje minimalne środowisko uruchomieniowe, bez dziedziczenia
tokenów hosta. To ograniczenie przypadkowych wycieków, nie sandbox.

Zdarzenia paneli to aktualizacje informacyjne, bez gwarancji trwałego doręczenia; po restarcie
panel odczytuje snapshot. Nie wolno na nich opierać automatycznego uruchamiania zadań. Przy
przepełnieniu ograniczonej kolejki host wysyła `resyncRequired`. Integracje czatu zachowują trwały
dziennik i zasady niepowtarzania niepewnych efektów. Każda subskrypcja ma właściciela i dispose;
cockpit lokalny korzysta ze wspólnego WebSocketu, hosted z SSE.

## Warunek powodzenia

Zewnętrzny projekt z samym publicznym SDK buduje działającą wtyczkę bez importów z wnętrza repo.
Instalujemy i wyłączamy ją przez UI bez restartu Cezara. Dwa różne zastosowania:
panel podsumowania projektu z akcją (`examples/extensions/project-summary`) oraz komunikator
(`examples/extensions/mattermost`). Awaria, aktualizacja lub usunięcie jednego dodatku nie psuje
podstawowej pracy ani drugiego dodatku.
