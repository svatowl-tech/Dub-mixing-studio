# Dub Mixing Studio — Руководство по релизу и CI/CD на GitHub

Этот репозиторий полностью настроен для автоматической сборки, тестирования и публикации релизов на GitHub с поддержкой всех ключевых настольных платформ (**Windows**, **macOS**, **Linux**), включая создание **инсталляторов (Setup)** и **портативных версий (Portable)**.

---

## 1. Автоматическая сборка и релизы на GitHub (GitHub Actions)

В папке `.github/workflows/` настроены два автоматизированных пайплайна:

1. **`ci.yml` (Continuous Integration)**:
   - Срабатывает при каждом `push` и `pull_request` в ветки `main`/`master`.
   - Проверяет TypeScript (`npm run lint`), целостность иконок (`npm run generate:icons`) и сборку фронтенда (`npm run build`).

2. **`release.yml` (Automated Multi-Platform Release)**:
   - Срабатывает при отправке тега версии вида `v*.*.*` (например, `git push origin v1.1.0`), либо при ручном запуске через вкладку **Actions -> Build & Release Dub Mixing Studio -> Run workflow**.
   - Собирает артефакты для всех платформ:
     - **Windows (x64)**:
       - `Dub_Mixing_Studio_x.x.x_Windows_Setup_x64.exe` (NSIS-установщик)
       - `Dub_Mixing_Studio_x.x.x_Windows_Portable_x64.zip` (Портативная версия)
     - **macOS (Intel x64 + Apple Silicon ARM64)**:
       - `Dub_Mixing_Studio_x.x.x_macOS_x64.dmg` / `.app.tar.gz`
       - `Dub_Mixing_Studio_x.x.x_macOS_aarch64.dmg` / `.app.tar.gz`
     - **Linux (x64)**:
       - `Dub_Mixing_Studio_x.x.x_Linux_x64.AppImage` (Портативный исполняемый файл)
       - `Dub_Mixing_Studio_x.x.x_Linux_x64.deb` (Пакет Debian/Ubuntu)
       - `Dub_Mixing_Studio_x.x.x_Linux_Portable_x64.tar.gz` (Архив)
   - Автоматически создает **GitHub Release**, прикрепляет все бинарные файлы и генерирует список изменений и контрольные суммы SHA-256.

---

## 2. Управление версиями (Автоматическая версионность)

Для синхронизации версий между файлами `package.json`, `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml` предусмотрен скрипт:

```bash
# Увеличение patch-версии (1.1.0 -> 1.1.1):
npm run version:bump patch

# Увеличение minor-версии (1.1.0 -> 1.2.0):
npm run version:bump minor

# Увеличение major-версии (1.1.0 -> 2.0.0):
npm run version:bump major

# Установка конкретной версии:
npm run version:bump 1.2.5
```

### Как выпустить новую версию в релиз:
```bash
# 1. Повысить версию
npm run version:bump minor

# 2. Закоммитить изменения
git add .
git commit -m "chore: release v1.2.0"

# 3. Создать тег и отправить на GitHub
git tag v1.2.0
git push origin main --tags
```
После отправки тега GitHub Actions автоматически запустит сборку всех платформ и опубликует релиз!

---

## 3. Генерация иконок (`npm run generate:icons`)

Tauri и операционные системы требуют строгого набора иконок различных размеров и форматов:
- Исходный вектор: `app-icon.svg` (современный логотип Dub Mixing Studio с виниловым диском и звуковыми волнами).
- Запуск генератора:
  ```bash
  npm run generate:icons
  ```
- Результаты создаются в:
  - `src-tauri/icons/`:
    - `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (512x512)
    - `icon.ico` (полноценный Windows ICO файл с размерами 16, 24, 32, 48, 64, 128, 256 px)
    - `icon.icns` (бинарный Apple Icon с заголовками для macOS)
    - Windows Store логотипы (`Square*.png`, `StoreLogo.png`)
  - `public/`:
    - `favicon.ico`, `favicon.svg`, `pwa-192x192.png`, `pwa-512x512.png`

---

## 4. Локальная разработка и сборка

- **Запуск веб-версии**:
  ```bash
  npm run dev
  ```
- **Сборка веб-версии**:
  ```bash
  npm run build
  ```
- **Сборка настольного приложения Tauri (локально)**:
  ```bash
  npm run build:desktop
  ```
