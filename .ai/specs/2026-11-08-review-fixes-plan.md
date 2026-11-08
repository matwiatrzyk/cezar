# Plan napraw po przeglądzie integracji

Cel: zamknąć R1–R11 z `2026-11-08-chat-integrations-independent-review.md`, sprawdzić reset parowania oraz poprawić opis CEZ_EXTENSIONS. Punkt wyjścia: da3b942dc. Użytkownik zlecił naprawy; lokalne commity są dozwolone. Bez pusha i zmian produkcyjnych poświadczeń.

## Podział i kryteria

1. Backend (jeden właściciel packages/cezar, packages/contract, packages/extension-sdk): R1 Telegram, R2 redakcja stderr, R3 anulowanie zewnętrznego chatu, R4 synchronizacja aktualizacji między procesami. Wspólny protokół i lifecycle uzasadniają jeden zakres. Testy najpierw: rzeczywisty bundled Telegram odbiera i odzyskuje offset; rzeczywisty ExtensionHost redaguje crash; opóźniony adapter respektuje anulowanie; dwa procesy po aktualizacji zgadzają się co do artefaktu. Zachować zgodność legacy SDK; nowe opcjonalne konteksty anulowania opisać rootowi.
2. Frontend (packages/web/src): R7 pomoc providera, R8 wartości formularzy, R9 wyniki komend; odtworzyć i usunąć reset parowania po zmianie listy rozszerzeń. Testy: prefiks Mattermosta; refetch clean vs dirty oraz canonical save i czyszczenie hasła; odwrotna kolejność odpowiedzi i dismiss; stabilność sesji setup przy WS update. Bez zmian SDK/backendu i przykładów.
3. Mattermost (examples/extensions/mattermost): R5 bezpieczne potwierdzanie działań i R6 postęp kursora przy równych timestampach. Zachować możliwość sterowania zadaniami. Dopuszczalne potwierdzenie tekstowe mapowane na istniejące opaque button event, z walidacją w core; żadnego omijania Confirm. Testy żądanie→potwierdzenie, obca osoba/rozmowa, 101 równoczesnych postów, późniejszy post i restart. Bez edycji SDK lub hosta; wymagane zmiany interfejsu zgłosić rootowi.
4. Root: R10 docs gwarancji dostarczeń, R11 forward/backward compatibility, .env.example; BC i poradnik autorów według finalnego API anulowania. Historyczny dossier zachować jako raport ocenianego SHA, dopisać status po naprawach.

## Kolejność w każdym zakresie

- Odczytać dowody w units/{2eb4173a,28affe1d,616ecf15,a3811c83}/notes.md w CEZ_TREE_DIR oraz dossier.
- Napisać i uruchomić test błędu; zachować wynik red z poprawnymi zależnościami.
- Naprawić przyczynę minimalnie, uruchomić test green i właściwe testy regresji.
- Zacommitować lokalnie bez Co-Authored-By; przedstawić SHA, zakres, red/green i ograniczenia.
- Root weryfikuje diff i dowody; dla backendu niezależny reviewer musi zatwierdzić przed merge. Merge pojedynczo przez --no-ff, po każdym odpowiednie testy integracyjne.
- Na scalonym stanie: typecheck, pełne npm test, test:unit, build/check:pack, test:package, docs, SDK test/pack oraz e2e rozszerzeń i właściwe zestawy chatowe. Nowe awarie diagnozować, nie rozszerzać schematów ani usuwać asercji dla uzyskania green.

## Ryzyka do sprawdzenia

- Offset Telegrama może przesunąć się dopiero po trwałej obsłudze hosta; nie zastępować tego pamięcią workera.
- Anulowanie musi docierać przed efektem; sprawdzenie po wysłaniu nie jest ochroną. Starsi adapterzy nie otrzymują magicznie możliwości anulowania już uruchomionej operacji; granicę jawnie opisać.
- Usunięcie artefaktu nie może pozostawić innego procesu ze starym aktywnym workerem i nowym manifestem.
- Formularz nie może bez ostrzeżenia nadpisać lokalnego szkicu, a wynik starej komendy nie może zastąpić aktualnego.
- Przykład Mattermosta nie może gubić ogona strony ani polegać na samym timestampie jako jednoznacznym kursorze.

Istniejący worktree jest izolowany. Cezar dispatch używa refs/heads/cez/177e722f, który był starszy od bieżącej gałęzi feature; przed dispatch zostanie bezpiecznie przesunięty fast-forward do zatwierdzonego punktu startowego, aby dzieci pracowały na aktualnym kodzie.
