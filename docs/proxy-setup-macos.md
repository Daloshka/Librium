# Librium: настройка прокси в macOS и как это устроено

[← Назад к индексу](../README.md) · Связано: [Архитектура](architecture.md), [Сеть](network.md), [Настройка прокси в Windows](proxy-setup.md)

Дополнение к [архитектуре](architecture.md) и [сети](network.md). Здесь про то, как
приложения в macOS узнают, что им надо ходить через 127.0.0.1:8080, где эти
настройки лежат, кто их читает, а кто игнорирует, и как всё проверить.

Проверено на macOS 14–26. Пути в GUI приведены для «Системных настроек»;
в старых версиях тот же раздел открывался через «Сеть → Дополнительно → Прокси».

---

## 1. Где живёт системный прокси

В macOS прокси задаётся не на всю систему, а отдельно для каждого сетевого
сервиса: Wi-Fi, Ethernet, USB-адаптер, VPN. Наборы сервисов объединены
в сетевое размещение (Network Location), их можно держать несколько
и переключать.

| Механизм                    | Где хранится                              | Кто читает                                   |
|-----------------------------|-------------------------------------------|----------------------------------------------|
| Системные настройки сети    | конфигурация сервиса, `networksetup`      | Safari, Chrome, Edge, большинство GUI-программ |
| Переменные окружения        | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`   | curl, git, pip, Python requests, Go, Node (частично) |
| Собственные настройки       | конфиг программы                          | Firefox, Java, Docker, многие CLI            |
| Аргументы запуска           | командная строка                          | `--proxy-server=127.0.0.1:8080` у Chromium   |

Посмотреть, что система считает текущим прокси:

    networksetup -listallnetworkservices
    networksetup -getwebproxy Wi-Fi
    networksetup -getsecurewebproxy Wi-Fi
    scutil --proxy

`scutil --proxy` показывает итоговую картину для активного сервиса, включая
PAC-файл (`ProxyAutoConfigEnable`) и список исключений.

Кто уважает эти настройки:

- Safari и Chromium (Chrome, Edge, Electron) берут их из системы.
- Firefox по умолчанию стоит на «Использовать системные настройки прокси»,
  но имеет и собственный выбор в «Настройки → Основные → Параметры сети».
- curl, git и большинство CLI системный прокси **не** читают: им нужны
  переменные окружения или явный `--proxy`.

---

## 2. Включить и выключить прокси

**GUI.** Системные настройки → Сеть → выбери интерфейс (Wi-Fi) → Подробнее… →
Прокси. Включи «Веб-прокси (HTTP)» и «Защищённый веб-прокси (HTTPS)»,
сервер `127.0.0.1`, порт `8080`. Подтверди кнопкой ОК.

**Терминал.** Имя сервиса пиши точно так, как его печатает
`networksetup -listallnetworkservices`; потребуются права администратора.

    networksetup -setwebproxy Wi-Fi 127.0.0.1 8080
    networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8080
    networksetup -setproxybypassdomains Wi-Fi "*.local" "169.254/16"

Выключить, сохранив адрес в настройках:

    networksetup -setwebproxystate Wi-Fi off
    networksetup -setsecurewebproxystate Wi-Fi off

Если ядро запущено на другом порту (`LIBRIUM_PROXY_PORT`), подставь его
вместо `8080` — актуальный адрес показан в шапке приложения.

Удобный приём: заведи отдельное сетевое размещение «Librium» с включённым
прокси и переключайся между ним и «Автоматически».

---

## 3. Доверие к CA

При первом запуске Librium создаёт свой корневой сертификат в
`~/Library/Application Support/Librium/ca.crt` (каталог меняется через
`LIBRIUM_DATA_DIR`). Без доверия к нему любой HTTPS через прокси даёт ошибку
сертификата.

**Связка ключей.** Открой `ca.crt` двойным щелчком: он попадёт в связку
«Вход» (login). Найди в Keychain Access сертификат **Librium Local CA**,
открой его, разверни «Доверие» и поставь «Всегда доверять» — достаточно
для «Протокол SSL».

**Терминал.** То же самое одной командой:

    security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db \
      "$HOME/Library/Application Support/Librium/ca.crt"

Проверить и удалить:

    security find-certificate -c "Librium Local CA" -p
    security delete-certificate -c "Librium Local CA"

Связку ключей используют Safari, Chrome и Edge. Firefox смотрит в своё
хранилище: либо импортируй `ca.crt` в «Настройки → Приватность и защита →
Сертификаты → Просмотр сертификатов → Центры сертификации», либо включи
`security.enterprise_roots.enabled = true` в about:config, тогда Firefox
начнёт доверять системному хранилищу.

Тот, у кого есть `ca.key`, может расшифровать любой HTTPS этого компьютера.
Ключ не передавай, а доверие к CA снимай, когда работа закончена.

---

## 4. Командная строка

curl системный прокси не читает — указывай его явно. Системный curl также
может не заглядывать в связку ключей, поэтому надёжнее передавать `--cacert`:

    curl --proxy http://127.0.0.1:8080 \
      --cacert "$HOME/Library/Application Support/Librium/ca.crt" https://example.com

Для программ, читающих окружение (git, pip, wget, Go, Rust reqwest):

    export HTTP_PROXY=http://127.0.0.1:8080
    export HTTPS_PROXY=http://127.0.0.1:8080
    export NO_PROXY=localhost,127.0.0.1

Значение `HTTPS_PROXY` начинается с `http://`: это адрес прокси, а не схема
целевого сайта. Отдельные корневые сертификаты задаются так:

    export REQUESTS_CA_BUNDLE="$HOME/Library/Application Support/Librium/ca.crt"   # Python requests
    export NODE_EXTRA_CA_CERTS="$HOME/Library/Application Support/Librium/ca.crt"  # Node.js

Chrome можно запустить с отдельным профилем, не трогая систему:

    open -na "Google Chrome" --args --proxy-server="127.0.0.1:8080" \
      --user-data-dir="$HOME/tmp/chrome-librium" --disable-quic

---

## 5. Брандмауэр и телефон

Телефон подключается к прокси по адресу компьютера в домашней сети:
порт прокси — тот же `8080`, страница с сертификатом — на порт больше (`8081`).

Брандмауэр macOS фильтрует по приложению, а не по портам. Состояние:

    /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

Если он включён, при первом LAN-доступе macOS сама спросит, разрешить ли
входящие подключения для Librium — ответь «Разрешить». Позже это меняется
в «Системные настройки → Сеть → Брандмауэр → Параметры…».

Гостевой Wi-Fi с изоляцией клиентов и активный VPN мешают телефону достучаться
до компьютера даже при разрешающем брандмауэре.

---

## 6. Типичные проблемы

| Симптом | Что делать |
| --- | --- |
| Порт 8080 занят другим приложением | Посмотри, кем: `lsof -nP -iTCP:8080 -sTCP:LISTEN`. Запусти Librium с `LIBRIUM_PROXY_PORT=8088` и укажи этот порт в клиенте. |
| В истории пусто, хотя прокси включён | Настройки заданы другому сетевому сервису (Ethernet вместо Wi-Fi) или трафик уходит в VPN. Проверь `scutil --proxy`. |
| curl ходит мимо прокси | Он не читает системные настройки: нужен `--proxy` или `HTTPS_PROXY`. |
| Ошибка сертификата в Chrome или Safari | CA не в связке «Вход» или без «Всегда доверять» (раздел 3). |
| Firefox не доверяет CA | Импортируй сертификат в его хранилище или включи `security.enterprise_roots.enabled`. |
| Часть сайтов проходит мимо истории | Приложение использует QUIC или certificate pinning. QUIC в Chrome отключается ключом `--disable-quic`, pinning не обходится. |
| «Librium.app повреждён» или «не удаётся открыть» | Сборка не подписана Apple Developer ID. Сними карантин: `xattr -dr com.apple.quarantine /Applications/Librium.app`, либо после отказа нажми «Всё равно открыть» в Системные настройки → Конфиденциальность и безопасность (на macOS до 15 достаточно правого клика → «Открыть»). |
