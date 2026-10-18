# Практика: увидеть теорию своими глазами

[← Назад к индексу](../README.md) · Связано: [Сеть](network.md), [TCP handshake](basics/tcp-handshake.md), [Глоссарий](basics/protocols.md)

Лестница из пяти ступеней от наблюдения к своему коду. Команды в разделах
1 и 2 проверены в примере, вывод приведён как пример.

---

## Окружение в примере

`openssl` есть, он идёт с Git for Windows, но его нет в PATH у PowerShell:

    C:\Program Files\Git\mingw64\bin\openssl.exe    OpenSSL 3.5.4

**Как сделано в примере.** В PATH нельзя добавить один файл, только
папку, а добавлять `C:\Program Files\Git\mingw64\bin` целиком плохо: там
лежат свои `curl.exe`, `git.exe` и десятки других утилит, они начнут
перекрывать системные. Скопировать один `openssl.exe` тоже нельзя, он тянет
`libcrypto` и `libssl` из своей папки.

Решение: своя папка для ярлыков, в ней один cmd-обёртка, папка в PATH.

    C:\Users\YOUR_USER\bin\openssl.cmd:

        @echo off
        "C:\Program Files\Git\mingw64\bin\openssl.exe" %*

    # папка добавлена в пользовательский PATH один раз:
    [Environment]::SetEnvironmentVariable('Path',
        [Environment]::GetEnvironmentVariable('Path','User') + ';' + "$env:USERPROFILE\bin", 'User')

Проверено, `openssl version` работает из любой оболочки и ничего не
перекрывает. В эту же папку дальше можно класть обёртки для других
утилит. В текущем окне PowerShell нужно один раз обновить переменную
(`$env:Path += ";$env:USERPROFILE\bin"`), новые окна подхватят сами.

Альтернатива только для PowerShell, если не хочется трогать PATH:

    Set-Alias openssl "C:\Program Files\Git\mingw64\bin\openssl.exe"

в файле профиля `$PROFILE`.

`curl.exe` системный, лежит в System32. `ncat` и `nc` не установлены,
вместо них ниже используется `TcpClient` из PowerShell.

---

## Ступень 1. Наблюдать чужой трафик

Поставить Wireshark с Npcap. Запустить захват, открыть любой сайт,
остановить.

Что найти:

- фильтр `tcp.flags.syn == 1` покажет только SYN и SYN-ACK, это
  [handshake](basics/tcp-handshake.md);
- развернуть дерево одного пакета сверху вниз: кадр Ethernet, IPv4, TCP,
  TLS. Это та же вложенность, что нарисована в
  [глоссарии](basics/protocols.md#что-в-поле-данные), только на настоящих байтах;
- фильтр `tls.handshake.type == 1` покажет ClientHello, внутри него
  видно расширение SNI с именем хоста открытым текстом и ALPN со списком
  протоколов.

Расшифровать HTTPS без всякого прокси: задать переменную окружения
и перезапустить браузер, затем указать этот файл в настройках Wireshark,
Protocols → TLS → Pre-Master-Secret log filename.

    [Environment]::SetEnvironmentVariable('SSLKEYLOGFILE', "$env:USERPROFILE\sslkeys.log", 'User')

---

## Ступень 2. Говорить протоколами вручную

### 2.1. HTTP по открытому TCP, без TLS

`ncat` нет, поэтому через .NET-класс прямо в PowerShell:

    $c = [Net.Sockets.TcpClient]::new('example.com', 80)
    "Локальный конец:  " + $c.Client.LocalEndPoint
    "Удалённый конец:  " + $c.Client.RemoteEndPoint
    $s = $c.GetStream(); $w = [IO.StreamWriter]::new($s); $r = [IO.StreamReader]::new($s)
    $w.Write("GET / HTTP/1.1`r`nHost: example.com`r`nConnection: close`r`n`r`n"); $w.Flush()
    $r.ReadToEnd()
    $c.Close()

Условный пример вывода:

    Локальный конец:  [::ffff:192.0.2.10]:49424
    Удалённый конец:  [::ffff:192.0.2.11]:80
    HTTP/1.1 200 OK
    Date: Sat, 05 Sep 2026 22:06:16 GMT
    Content-Type: text/html
    Transfer-Encoding: chunked
    Connection: close
    Server: cloudflare

Что здесь видно:

- **четвёрка TCP** из [handshake](basics/tcp-handshake.md#5-что-происходит-внутри-ос):
  локальный порт 49424 выбран ядром из эфемерного диапазона, удалённый 80 известен заранее;
- адрес записан как `::ffff:192.0.2.11`, это IPv4 внутри IPv6-сокета;
- HTTP это буквально текст, который вы напечатали руками;
- `\r\n` обязательны, и пустая строка в конце тоже, она отделяет заголовки от тела.

### 2.2. То же самое, но внутри TLS

    printf 'GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n' | \
      openssl s_client -connect example.com:443 -servername example.com -brief

Реальный вывод, хвост:

    Connecting to 192.0.2.11
    CONNECTION ESTABLISHED
    Protocol version: TLSv1.3
    Ciphersuite: TLS_AES_256_GCM_SHA384
    Peer certificate: CN=example.com
    Verification: OK
    Negotiated TLS1.3 group: X25519MLKEM768

Ответ пришёл тот же, что по порту 80, только внутри шифрования. Флаг
`-servername` это и есть SNI: без него сервер за Cloudflare не поймёт,
какой сайт нужен. Обратите внимание на группу обмена ключами
`X25519MLKEM768`, это постквантовый гибрид, уже включён по умолчанию.

Интерактивно, чтобы набрать запрос пальцами: запустить без `printf`,
дождаться приглашения, ввести `GET / HTTP/1.1`, затем `Host: example.com`,
затем Enter дважды. Выход по `Q`.

### 2.3. Цепочка сертификатов и ALPN

    openssl s_client -connect example.com:443 -servername example.com -alpn h2,http/1.1

Условный пример вывода:

    Certificate chain
     0 s:CN=example.com
       i:C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
     1 s:CN=Cloudflare TLS Issuing ECC CA 3
       i:C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
     2 s:CN=SSL.com TLS Transit ECC CA R2
       i:C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
     3 s:CN=SSL.com TLS ECC Root CA 2022
       i:C=GB, ..., CN=AAA Certificate Services
    New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
    ALPN protocol: h2
    Verify return code: 0 (ok)

Читается снизу вверх: `s:` это subject, кому выдан, `i:` это issuer,
кто выдал. Корень в доверенном хранилище, каждый следующий подписан
предыдущим, последний выдан на example.com. Ровно эту цепочку Librium
будет подменять своей: один самоподписанный CA и один лист на хост.

`ALPN protocol: h2` означает, что сервер выбрал HTTP/2. Прокси v1 будет
предлагать браузеру только `http/1.1`, чтобы внутри был текст.

### 2.4. DNS

    Resolve-DnsName example.com -Type A_AAAA

Условный пример вывода:

    Name        Type IPAddress
    example.com    A 192.0.2.11
    example.com    A 192.0.2.12

Два адреса, оба Cloudflare. Клиент выберет любой. С настроенным прокси
этот запрос делает не браузер, а прокси.

### 2.5. Ошибки TCP наглядно

    try { [Net.Sockets.TcpClient]::new().Connect('127.0.0.1', 9) }
    catch { $_.Exception.InnerException.SocketErrorCode }

Условный пример вывода:

    ConnectionRefused

Порт 9 никто не слушает, ядро сразу ответило RST. Сравните с недоступным
хостом, где ответа нет вовсе и вызов виснет секунд на двадцать.
Разбор в [tcp-handshake.md, раздел 6](basics/tcp-handshake.md#6-что-бывает-когда-что-то-не-так).

### 2.6. Живые соединения системы

    Get-NetTCPConnection -State Established -RemotePort 443 |
      Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess

Условный пример вывода:

    LocalAddress LocalPort RemoteAddress RemotePort
    192.0.2.13     65515 192.0.2.14        443
    192.0.2.10       65514 192.0.2.15        443
    192.0.2.13     65502 192.0.2.14        443

Каждая строка это одна четвёрка. Локальные порты идут подряд из
эфемерного диапазона, к одному серверу открыто несколько соединений
сразу. Именно так браузер будет подключаться к Librium на 8080.

---

## Ступень 3. Пройти путь через чужой прокси

Поставить mitmproxy, он делает то же, что будет делать Librium, и служит
эталоном для сравнения.

1. Запустить `mitmproxy` или `mitmweb`, он слушает 8080.
2. Настроить браузер по [proxy-setup.md](proxy-setup.md).
3. Открыть `http://mitm.it`, скачать и установить CA.
4. Смотреть историю запросов в интерфейсе.
5. Параллельно включить Wireshark с фильтром `tcp.port == 8080`
   и убедиться своими глазами: сначала идёт `CONNECT example.com:443`
   открытым текстом, потом TLS, где сертификат выдан CA mitmproxy.

Проверка прокси из командной строки, эти же команды пригодятся
для Librium:

    curl -v --proxy http://127.0.0.1:8080 -k https://example.com
    curl -v --proxy http://127.0.0.1:8080    https://example.com

Первая игнорирует сертификат и проверяет сам прокси. Вторая проверяет,
что CA установлен правильно.

---

## Ступень 4. Написать примитивы на Rust

Не начинать сразу с прокси. Четыре программы по полсотни строк, каждая
проверяется отдельно. Сложенные вместе, они дают MITM-прокси почти
без нового кода.

- [ ] **Эхо-сервер на tokio.** `TcpListener::bind`, цикл `accept`,
      `tokio::spawn` на соединение, чтение и запись обратно.
      Это первая схема из [architecture.md](architecture.md#прослушивание-порта).
      Проверка: подключиться скриптом из 2.1.
- [ ] **TCP-туннель.** Слушает порт, на каждое соединение подключается
      к жёстко заданному `example.com:80` и гоняет байты в обе стороны
      через `tokio::io::copy_bidirectional`. Проверка: отправить в него
      HTTP-запрос из 2.1 и получить ответ. Это половина прокси.
- [ ] **CA и сертификат через rcgen.** Сгенерировать корневой, сохранить
      в PEM, сгенерировать лист на `example.com`, подписать. Установить
      корневой: `certutil -addstore -user Root ca.crt`. Проверка:
      `openssl x509 -in ca.crt -text -noout` и просмотр в certmgr.msc.
- [ ] **TLS-сервер на tokio-rustls.** Отдаёт одну строку по HTTPS
      с сертификатом из предыдущего пункта. Проверка: `curl https://localhost:8443`
      без `-k` должен пройти, если CA установлен.

Затем сборка: туннель, который на CONNECT поднимает TLS с обеих сторон.

---

## Ступень 5. Ломать и объяснять

Когда прокси заработает, сломать намеренно. Правило: сначала гипотеза
вслух, потом проверка в Wireshark.

- [ ] Удалить CA из хранилища. Что скажет браузер и на каком шаге упадёт?
- [ ] Подключиться к закрытому порту. RST или таймаут?
- [ ] Зайти на сайт с certificate pinning, например мобильное банковское
      приложение через прокси. Где именно оборвётся соединение?
- [ ] Открыть сайт, требующий HTTP/2, не объявив ALPN. Что произойдёт?
- [ ] Отключить прокси в браузере, оставив системный. Кто из программ
      продолжит ходить через прокси, а кто нет?

---

## Сквозные привычки

- Держать Wireshark открытым, пока пишете код. Это отладчик уровня сети,
  который показывает, что реально ушло в провод, а не что вы думали отправить.
- Дописывать в документы Librium всё, что узнали на практике, особенно
  расхождения с тем, что там написано сейчас.
