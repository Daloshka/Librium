# Реестр Windows: HKCU, HKLM и остальные ветки

[← Назад к индексу](../../README.ru.md) · Связано: [Настройка прокси](../proxy-setup.md)

---

## 1. Что такое реестр

Реестр это иерархическая база данных настроек Windows. Всё, что в Linux
разложено по файлам в `/etc` и `~/.config`, в Windows лежит в реестре:
параметры системы, драйверов, служб, установленных программ и пользователей.

Структура похожа на файловую систему:

- **Ключ** (key) это аналог папки. Путь вида
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`.
- **Значение** (value) это аналог файла внутри ключа: имя, тип и данные.
  Например `ProxyEnable` типа DWORD с данными `1`.

Типы значений, которые встречаются чаще всего:

| Тип           | Что хранит                                  | Пример                          |
|---------------|---------------------------------------------|---------------------------------|
| REG_SZ        | строка                                      | `127.0.0.1:8080`                |
| REG_DWORD     | 32-битное целое, часто как флаг 0/1         | `ProxyEnable = 1`               |
| REG_QWORD     | 64-битное целое                             | таймстампы, размеры             |
| REG_BINARY    | произвольные байты                          | сертификаты, сериализованные структуры |
| REG_MULTI_SZ  | список строк                                | списки путей, зависимости служб |
| REG_EXPAND_SZ | строка с переменными окружения `%SystemRoot%` | пути к программам             |

---

## 2. Корневые ветки (hives)

На верхнем уровне пять корней. Реально независимых только два, остальные
это ссылки или виртуальные представления.

| Сокращение | Полное имя            | Что внутри                                                   |
|------------|-----------------------|--------------------------------------------------------------|
| **HKLM**   | HKEY_LOCAL_MACHINE    | Настройки всего компьютера: система, драйверы, службы, программы для всех пользователей |
| **HKCU**   | HKEY_CURRENT_USER     | Настройки того пользователя, под которым запущен процесс     |
| HKU        | HKEY_USERS            | Настройки всех загруженных пользователей, HKCU это ссылка на одну из подветок |
| HKCR       | HKEY_CLASSES_ROOT     | Ассоциации файлов и COM-классы, склейка `HKLM\Software\Classes` и `HKCU\Software\Classes` |
| HKCC       | HKEY_CURRENT_CONFIG   | Текущий профиль оборудования, ссылка внутрь HKLM             |

---

## 3. HKCU и HKLM: в чём разница

### Кому принадлежит

- **HKLM** общий для всех пользователей машины. Здесь то, что влияет
  на систему целиком.
- **HKCU** личный для каждого пользователя. У каждой учётной записи
  свой набор. Когда процесс обращается к HKCU, Windows подставляет ветку
  того пользователя, под которым процесс запущен. Физически это
  `HKU\<SID пользователя>`, где SID это идентификатор вида `S-1-5-21-...`.

### Где хранится на диске

- **HKLM** собирается из нескольких файлов в `C:\Windows\System32\config\`:
  `SYSTEM`, `SOFTWARE`, `SAM`, `SECURITY`, `DEFAULT`.
- **HKCU** это файл `NTUSER.DAT` в профиле пользователя,
  `C:\Users\<имя>\NTUSER.DAT`. Он скрытый и заблокирован, пока
  пользователь вошёл в систему. Часть HKCU, а именно
  `HKCU\Software\Classes`, лежит отдельно в
  `C:\Users\<имя>\AppData\Local\Microsoft\Windows\UsrClass.dat`.

Отсюда практическое следствие: HKCU переезжает вместе с профилем,
HKLM привязан к установке Windows.

### Права

- Запись в **HKCU** не требует прав администратора: пользователь владеет
  своей веткой. Поэтому настройки прокси WinINET из
  [proxy-setup.md](../proxy-setup.md) можно менять из обычного процесса.
- Запись в **HKLM** почти везде требует прав администратора (UAC).
  Чтение в основном разрешено всем, кроме чувствительных подветок
  вроде `SAM` и `SECURITY`, где лежат хэши паролей.

### Приоритет

Когда одна и та же настройка есть в обеих ветках, программа сама решает,
что важнее. Типичные варианты:

- Политики (`Policies`) из HKLM переопределяют пользовательские: так
  работают групповые политики, администратор может запретить менять прокси.
- Пользовательская настройка переопределяет машинную: так ведут себя
  большинство обычных программ, HKLM даёт умолчание, HKCU его уточняет.

---

## 4. Примеры, связанные с Librium

**Настройки прокси WinINET** живут в HKCU, поэтому у каждого пользователя
свой прокси и не нужен администратор:

    HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
        ProxyEnable   REG_DWORD  1
        ProxyServer   REG_SZ     127.0.0.1:8080
        ProxyOverride REG_SZ     <local>

**Настройки прокси WinHTTP** для служб живут в HKLM, потому что службы
работают не от пользователя:

    HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\Connections
        WinHttpSettings  REG_BINARY  ...

**Хранилища сертификатов** есть в обеих ветках. Команда
`certutil -addstore -user Root ca.crt` пишет в пользовательское:

    HKCU\Software\Microsoft\SystemCertificates\Root\Certificates\<отпечаток>

а без `-user` в машинное, куда нужен администратор:

    HKLM\SOFTWARE\Microsoft\SystemCertificates\Root\Certificates\<отпечаток>

Chrome и Edge доверяют обоим. Для Librium достаточно пользовательского.

**Автозапуск** программы:

    HKCU\Software\Microsoft\Windows\CurrentVersion\Run   для этого пользователя
    HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run   для всех

**Групповая политика, запрещающая менять прокси**, если вдруг Librium
не может включить системный прокси:

    HKCU\Software\Policies\Microsoft\Internet Explorer\Control Panel
        Proxy  REG_DWORD  1

---

## 5. Wow6432Node: 32-битные программы на 64-битной Windows

В `HKLM\SOFTWARE` есть подветка `Wow6432Node`. Туда Windows прозрачно
перенаправляет 32-битные программы, когда те пишут в `HKLM\SOFTWARE`.
64-битная программа видит `HKLM\SOFTWARE\Vendor`, 32-битная видит то же
имя, но реально пишет в `HKLM\SOFTWARE\Wow6432Node\Vendor`. Если Librium
будет собран как 64-битный, что для Rust на Windows стандарт, эта ветка
не касается. Но искать настройки чужих 32-битных программ надо там.

---

## 6. Как читать и писать

**regedit.exe**, графический редактор. Адресная строка вверху принимает
путь целиком, удобно вставлять.

**PowerShell.** Ветки доступны как диски `HKCU:` и `HKLM:`:

    Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' ProxyEnable 1
    New-Item 'HKCU:\Software\Librium'
    Remove-ItemProperty 'HKCU:\Software\Librium' SomeValue

**reg.exe**, классическая утилита:

    reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    reg add   "HKCU\Software\Librium" /v Port /t REG_DWORD /d 8080 /f
    reg export "HKCU\Software\Librium" backup.reg
    reg import backup.reg

**Из Rust.** Крейт `winreg`:

    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")?;
    key.set_value("ProxyEnable", &1u32)?;
    key.set_value("ProxyServer", &"127.0.0.1:8080")?;

После записи настроек прокси нужно ещё вызвать `InternetSetOption`,
см. [proxy-setup.md](../proxy-setup.md#2-wininet-то-что-называют-системным-прокси).

**Резервная копия перед правкой.** Реестр не имеет отмены. Перед
экспериментами делать `reg export` нужной ветки, а на машине целиком
точку восстановления.

---

## 7. Где Librium должен хранить свои настройки

Правильный вариант для десктопной программы на Windows: не реестр,
а файл в профиле пользователя:

    %APPDATA%\Librium\config.toml        настройки
    %LOCALAPPDATA%\Librium\ca.pem        ключ CA, только этот пользователь
    %LOCALAPPDATA%\Librium\history.db    история трафика

`%APPDATA%` (Roaming) переезжает с профилем в домене, `%LOCALAPPDATA%`
остаётся на машине. В реестр Librium пишет только чужие настройки,
то есть системный прокси, и только по явной команде пользователя.
