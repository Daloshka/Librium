# Librium: как выпускается релиз

[← Назад к индексу](../README.ru.md) · Связано: [Архитектура](architecture.md), [Настройка прокси в macOS](proxy-setup-macos.md)

Что происходит от «поднять версию» до готовых файлов на странице релизов,
какие секреты включают подпись и нотаризацию macOS, как обновить Homebrew
tap и Scoop bucket и как проверить скачанный дистрибутив.

Сборкой занимается GitHub Actions: [.github/workflows/release.yml](../.github/workflows/release.yml).
Локально ничего собирать и никуда выкладывать вручную не нужно.

---

## 1. Что выпускается

| Файл                            | Платформа                  | Чем собран                     |
|---------------------------------|----------------------------|--------------------------------|
| `Librium-X.Y.Z-arm64.dmg`       | macOS, Apple Silicon       | electron-builder, target `dmg` |
| `Librium-X.Y.Z-arm64.zip`       | macOS, Apple Silicon       | electron-builder, target `zip` |
| `Librium.X.Y.Z.exe`             | Windows 10/11, x64         | electron-builder, target `portable` |

electron-builder кладёт всё в `dist/vX.Y.Z/`. Имя Windows-файла на диске —
`Librium X.Y.Z.exe`, с пробелами; при выкладке GitHub заменяет пробелы
точками, поэтому в релизе он называется `Librium.X.Y.Z.exe`. На это имя
ссылается Scoop-манифест, менять его не нужно.

Внутри `.app` лежит ядро на Rust: `Contents/Resources/core/librium`.
На Windows — `resources/core/librium.exe`.

---

## 2. Поднять версию

Версия живёт в трёх местах, все три обязательны:

- `Cargo.toml` → `version`. Отсюда её берёт ядро (`env!("CARGO_PKG_VERSION")`)
  и отдаёт в API, а интерфейс показывает её в левой колонке.
- `package.json` → `version`. Это версия Electron-приложения и часть имён
  артефактов.
- `package.json` → `build.directories.output` → `dist/vX.Y.Z`. Каталог сборки;
  на него настроены пути выгрузки в workflow (`dist/v*/…`).

Дальше обновить `Cargo.lock` и прогнать проверки:

    cargo update -w --offline
    cargo fmt --check
    cargo test --locked
    cargo clippy --locked --all-targets -- -D warnings
    npm ci
    npm run test:ui
    python3 scripts/export-source.py --check

Коммит с поднятой версией уходит в `main` до тега.

---

## 3. Тег и запуск сборки

    git tag vX.Y.Z
    git push origin vX.Y.Z

Workflow срабатывает на `push` тега `v*` и на каждой из двух машин
(`windows-latest`, `macos-latest`) делает одно и то же: `npm ci`,
`npm run dist` (сначала `scripts/build-core.cjs` собирает Rust-ядро
в `target/release`, затем electron-builder упаковывает приложение),
выгружает артефакты и прикладывает их к релизу через
`softprops/action-gh-release`. Заметки к релизу GitHub генерирует сам
(`generate_release_notes: true`), права задачи — `contents: write`.

Обе машины пишут в один и тот же релиз, порядок завершения не важен.

Посмотреть ход сборки:

    gh run watch --repo Daloshka/Librium

---

## 4. Подпись и нотаризация macOS

Без секретов сборка macOS остаётся такой же, как сейчас: ad-hoc подпись
(`mac.identity: "-"` в `package.json`), Gatekeeper её не принимает,
пользователь снимает карантин вручную. Как только секреты появятся
в репозитории, workflow сам переключится на подписанную ветку — менять
YAML для этого не нужно.

### Секреты

| Секрет                        | Что это                                                                 |
|-------------------------------|-------------------------------------------------------------------------|
| `MAC_CERT_P12_BASE64`         | сертификат Developer ID Application вместе с приватным ключом, экспортированный в `.p12` и закодированный base64 |
| `MAC_CERT_PASSWORD`           | пароль этого `.p12`                                                     |
| `APPLE_ID`                    | Apple ID учётной записи разработчика                                    |
| `APPLE_APP_SPECIFIC_PASSWORD` | пароль приложения для этого Apple ID                                    |
| `APPLE_TEAM_ID`               | Team ID, десять символов                                                |

Все пять нужны вместе. Подпись включается по наличию `MAC_CERT_P12_BASE64`,
а нотаризация без остальных трёх упадёт с явной ошибкой electron-builder.

### Где их взять

1. Членство в Apple Developer Program, 99 $ в год. Без него сертификата
   Developer ID не выдадут.
2. Сертификат: Xcode → Settings → Accounts → Manage Certificates → + →
   Developer ID Application. Или вручную: Keychain Access →
   Certificate Assistant → Request a Certificate From a Certificate
   Authority, затем загрузить CSR на
   developer.apple.com/account/resources/certificates и скачать `.cer`.
3. Экспорт: Keychain Access → раскрыть строку «Developer ID Application: …»,
   выделить сертификат **вместе с ключом** → Export → формат
   Personal Information Exchange (.p12) → задать пароль. Пароль и есть
   `MAC_CERT_PASSWORD`.
4. Пароль приложения: appleid.apple.com → Sign-In and Security →
   App-Specific Passwords → +. Это `APPLE_APP_SPECIFIC_PASSWORD`;
   обычный пароль Apple ID notarytool не примет.
5. Team ID: developer.apple.com/account → Membership details.

Загрузить секреты:

    base64 -i Librium-DeveloperID.p12 > cert.b64
    gh secret set MAC_CERT_P12_BASE64 --repo Daloshka/Librium < cert.b64
    rm cert.b64
    gh secret set MAC_CERT_PASSWORD --repo Daloshka/Librium
    gh secret set APPLE_ID --repo Daloshka/Librium
    gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo Daloshka/Librium
    gh secret set APPLE_TEAM_ID --repo Daloshka/Librium

Команды без `<` спросят значение в терминале и не оставят его в истории
оболочки. Сам `.p12` в репозиторий не кладётся никогда.

### Что делает workflow

Секреты нельзя читать прямо в `if:` шага, поэтому они подняты в `env`
задачи, а шаги проверяют `env.MAC_CERT_P12_BASE64 != ''`.

- **Import signing certificate.** Декодирует base64 во временный `.p12`,
  создаёт временную связку ключей в `$RUNNER_TEMP`, снимает с неё
  автоблокировку, импортирует сертификат с `-T /usr/bin/codesign`,
  открывает доступ к ключу через `security set-key-partition-list`,
  добавляет связку в пользовательский поисковый список и удаляет `.p12`.
  Если в связке не оказалось Developer ID Application, шаг падает сразу,
  не тратя двадцать минут на сборку.
- **Build installers (signed and notarized).**

      npm run dist -- -c.mac.identity="Developer ID Application" \
        -c.mac.hardenedRuntime=true -c.mac.notarize=true

  Три флага перекрывают то, что записано в `package.json` (`identity: "-"`,
  `hardenedRuntime: false`). `-c.…` перекрывает конфигурацию точечно,
  остальные настройки сборки остаются на месте.
- **Verify signature.** `codesign --verify --deep --strict`, `spctl`
  и `xcrun stapler validate` по свежесобранному `.app`. Шаг помечен
  `continue-on-error: true`: он показывает результат в логе, но не рушит
  уже готовый релиз.
- **Remove temporary keychain.** Шаг с `if: always()` — связка удаляется
  и при провале сборки.

electron-builder 26 при `mac.notarize: true` берёт учётные данные из
переменных окружения в таком порядке: `APPLE_ID` +
`APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, либо `APPLE_API_KEY` +
`APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (ключ App Store Connect API,
для CI надёжнее), либо `APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE`.
Дальше `@electron/notarize` отправляет `.app` в `notarytool`, ждёт ответа
Apple и делает `stapler staple`, то есть прикрепляет билет к бандлу.
`dmg` и `zip` собираются уже из заверенной сборки, поэтому отдельно
заверять их не нужно.

Ядро `librium` из `extraResources` подписывается вместе с бандлом:
`@electron/osx-sign` обходит весь `Contents` и подписывает каждый найденный
Mach-O файл. Это важно — нотаризация не пропустит бандл, внутри которого
есть неподписанный исполняемый файл.

Entitlements берутся из шаблона electron-builder
(`allow-jit`, `allow-unsigned-executable-memory`,
`disable-library-validation`). Если понадобятся свои, положить
`build/entitlements.mac.plist` — electron-builder подхватит файл сам.

---

## 5. Windows: Authenticode (необязательно)

Сейчас `.exe` не подписан, поэтому SmartScreen при первом запуске
показывает предупреждение «Windows protected your PC». Подпись включается
без правки логики workflow:

1. Получить сертификат для подписи кода (OV или EV) у любого
   удостоверяющего центра, экспортировать в `.pfx`.
2. Сложить его в секреты:

       base64 -i librium.pfx > pfx.b64
       gh secret set WIN_CSC_LINK --repo Daloshka/Librium < pfx.b64
       rm pfx.b64
       gh secret set WIN_CSC_KEY_PASSWORD --repo Daloshka/Librium

3. Пробросить их в шаг сборки как `env`:

       env:
         WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
         WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}

electron-builder видит эти переменные и подписывает portable-`.exe` сам,
`win.signAndEditExecutable: true` уже стоит в `package.json`.
Универсальные `CSC_LINK` / `CSC_KEY_PASSWORD` тоже работают, но на macOS
они включают собственный механизм импорта сертификата electron-builder
и конфликтуют с временной связкой из шага выше — на Windows лучше
пользоваться именно `WIN_*`.

EV-сертификаты обычно живут на аппаратном токене или в HSM, автоматически
подписать ими на runner нельзя; для таких случаев есть облачная подпись
(`win.azureSignOptions`) или собственный хук.

---

## 6. Проверить готовый файл

Скачать артефакт со страницы релиза и, для macOS:

    shasum -a 256 Librium-X.Y.Z-arm64.dmg
    hdiutil attach Librium-X.Y.Z-arm64.dmg
    codesign --verify --deep --strict --verbose=2 /Volumes/Librium*/Librium.app
    codesign --display --verbose=4 /Volumes/Librium*/Librium.app
    spctl --assess --type exec -vv /Volumes/Librium*/Librium.app
    xcrun stapler validate /Volumes/Librium*/Librium.app
    hdiutil detach /Volumes/Librium*

Что считать нормой:

| Сборка              | `codesign --display`                        | `spctl --assess`                        |
|---------------------|---------------------------------------------|-----------------------------------------|
| подписанная         | `Authority=Developer ID Application: …`      | `accepted, source=Notarized Developer ID` |
| ad-hoc (сегодня)    | `Signature=adhoc`                            | `rejected` — ожидаемо                   |

`stapler validate` на ad-hoc сборке скажет, что билета нет; это тоже
ожидаемо. Пользователь такой сборки снимает карантин сам:

    xattr -dr com.apple.quarantine /Applications/Librium.app

Для Windows:

    certutil -hashfile Librium.X.Y.Z.exe SHA256
    Get-AuthenticodeSignature .\Librium.X.Y.Z.exe

У неподписанного файла `Status` будет `NotSigned`.

---

## 7. Обновить Homebrew tap и Scoop bucket

Пакеты живут в отдельных репозиториях и обновляются после того, как файлы
появились в релизе:

    git clone https://github.com/Daloshka/homebrew-tap
    cd homebrew-tap && ./update.sh X.Y.Z

    git clone https://github.com/Daloshka/scoop-bucket
    cd scoop-bucket && ./update.sh X.Y.Z

Скрипт скачивает нужный артефакт, считает `sha256` и переписывает версию
и контрольную сумму в `Casks/librium.rb` (Homebrew) или
`bucket/librium.json` (Scoop). Коммит и push скрипт не делает — печатает
команды, их надо выполнить самому, посмотрев на `git diff`.

Проверка после публикации:

    brew update && brew info --cask daloshka/tap/librium
    scoop update && scoop info librium

---

## 8. Если релиз надо переделать

Пока по ссылкам никто не успел скачать файлы и менеджеры пакетов на них
не ссылаются, тег можно переиграть:

    gh release delete vX.Y.Z --repo Daloshka/Librium --yes
    git push --delete origin vX.Y.Z
    git tag -d vX.Y.Z

После этого поправить всё нужное, поставить тег заново и запушить.

Если версию уже подхватил Homebrew или Scoop, старую версию не трогают:
контрольные суммы в манифестах перестанут сходиться, и установка сломается
у всех, кто ещё не обновился. В этом случае выпускается следующая
патч-версия.
