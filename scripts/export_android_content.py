#!/usr/bin/env python3
"""Generate Android's language content and the web's versioned content package from the Swift modules.

Only declarative string content is translated; Kotlin owns the runtime policy and models.
Modules are discovered from `LanguageRegistry.all` in `apps/ios/Core/Languages/LanguageModule.swift`,
so adding a Swift module and registering it is enough to export it. Run --check in CI to
detect drift between platforms.
"""
import argparse
import json
import pathlib
import re
import textwrap

KOTLIN_DEST = 'apps/android/app/src/main/java/chat/mural/core/Languages.kt'
# The web app reads this versioned content package instead of parsing Swift (docs/repository-layout.md).
WEB_DEST = 'apps/web/server/src/content/languages.v1.json'
WEB_PACK_VERSION = 1
# Fields whose value is a nested structure (array/dict), extracted separately from the
# simple quoted-string fields.
STRUCTURED_FIELDS = ('teachingFocus', 'themeOverrides')


def quoted(text):
    return json.dumps(text, ensure_ascii=False).replace('$', r'\$')


def swift_strings(text):
    return [json.loads('"' + value + '"') for value in re.findall(r'"((?:[^"\\]|\\.)*)"', text)]


def theme(text):
    vals = swift_strings(text)
    color = int(re.search(r',\s*(\d+)\s*\)$', text).group(1))
    if len(vals) != 6:
        raise SystemExit(f'Unexpected ConversationTheme arguments {vals}; expected six strings and a color index.')
    return 'ConversationTheme(' + ', '.join(map(quoted, vals)) + ', ' + str(color) + ')'


def struct_fields(language_module_swift_text):
    """Stored properties of the `LanguageModule` struct, in declaration order."""
    return re.findall(r'\bpublic let (\w+):', language_module_swift_text)


def language_files(core):
    """`apps/ios/Core/Languages/*.swift` files, ordered as declared in `LanguageRegistry.all`."""
    text = (core / 'Languages/LanguageModule.swift').read_text()
    match = re.search(r'public static let all:\s*\[LanguageModule\]\s*=\s*\[([^\]]*)\]', text)
    if not match:
        raise SystemExit('LanguageRegistry.all not found in apps/ios/Core/Languages/LanguageModule.swift.')
    names = re.findall(r'\.(\w+)', match.group(1))
    return [core / 'Languages' / f'{name[0].upper()}{name[1:]}.swift' for name in names]


def call_arguments(module_swift_text):
    """Argument labels used in a module file's `LanguageModule(...)` initializer call.

    Matches a label at the start of a line, or after a comma on the same line, so that
    quoted `themeOverrides` dictionary keys (which start their own line but are not
    followed by a same-line label) are never mistaken for an argument.
    """
    return set(re.findall(r'(?:^|,)[ \t]*(\w+):[ \t]', module_swift_text, re.MULTILINE))


def meaning_languages(text):
    """Kotlin lines for `MeaningLanguages`, read from the Swift enum so both clients offer the same list."""
    block = re.search(r'enum MeaningLanguages\s*\{(.*?)\n\}', text, re.S)
    if not block:
        raise SystemExit('MeaningLanguages not found in Core/Languages/LanguageModule.swift.')
    names = re.search(r'static let all\s*=\s*\[(.*?)\]', block.group(1), re.S)
    greetings = re.search(r'func greeting\(in language: String\)[^\[]*\[(.*?)\]\[language\]\s*\?\?\s*("(?:[^"\\]|\\.)*")', block.group(1), re.S)
    if not names or not greetings:
        raise SystemExit('MeaningLanguages.all or greeting(in:) has an unexpected shape in Core/Languages/LanguageModule.swift.')
    pairs = re.findall(r'("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")', greetings.group(1))
    if not pairs:
        raise SystemExit('MeaningLanguages greetings not found in Core/Languages/LanguageModule.swift.')
    return ['    val all = listOf(' + ', '.join(map(quoted, swift_strings(names.group(1)))) + ')',
            '    fun greeting(language: String) = mapOf(' + ', '.join(f'{quoted(json.loads(k))} to {quoted(json.loads(v))}' for k, v in pairs)
            + f')[language] ?: {quoted(json.loads(greetings.group(2)))}']


# TeachingPolicy.swift has no opening line or correction rules for Dutch and Russian; both apps fall
# back to a generic default. The web content package adds them here, in the style of the other
# modules, and marks them as awaiting review by a native speaker. Move them into Swift and Kotlin
# once reviewed; this table then becomes unnecessary because the exporter reads Swift first.
WEB_SUPPLEMENTS = {
    'nl': {
        'introduction': 'Je bent Mural, een gesprekspartner die een volwassene helpt Nederlands te oefenen. Spreek alleen Nederlands, vriendelijk en in een rustig tempo.',
        'conversationGuidance': (
            'Corrigeer een duidelijke taalfout in het laatste antwoord, ook als de betekenis te begrijpen is. Wijs kort op de foute vorm en zeg de verbeterde zin voordat je verdergaat. '
            'Corrigeer hooguit één fout per beurt. Komt de fout terug, nodig dan uit tot een korte nieuwe poging. Noem iets alleen een correctie als je echt een foute vorm verandert. '
            'Herhaal nooit een al correcte zin als zogenaamde correctie. Respecteer dialecten en stijlkeuzes. Heb je het niet goed verstaan, vraag dan door in plaats van te raden.\n'
            'Houd je antwoorden kort, met hooguit één vraag. Prijs niet elk antwoord. Spreek een duidelijk onjuiste bewering vriendelijk tegen. '
            'Leerdoelen gaan niet boven het onderwerp dat de persoon kiest. Geef tijd om na te denken; reageer tijdens een stilte alleen als de app daarom vraagt.\n'
            'Als de persoon van onderwerp wisselt of om een ander onderwerp vraagt, moet je volgende beurt één korte vraag zijn om die wissel te bevestigen. '
            'Wacht op het antwoord voordat je over het nieuwe onderwerp praat. Het verzoek zelf start deze bevestiging; het telt niet als antwoord. '
            'Ga na de bevestiging vanzelfsprekend verder zonder opnieuw te vragen. Bijbehorende details hebben geen bevestiging nodig. Onthoud wat al is verteld. '
            'Een correcte zin over een ander onderwerp is geen taalfout.'),
    },
    'ru': {
        'introduction': 'Ты — Mural, собеседница, которая помогает взрослому человеку практиковать русский язык. Говори только по-русски, дружелюбно и в спокойном темпе.',
        'conversationGuidance': (
            'Исправляй явную языковую ошибку в последнем ответе, даже если смысл понятен. Кратко укажи неправильную форму и произнеси исправленную фразу, прежде чем продолжить. '
            'Исправляй не более одной ошибки за реплику. Если ошибка повторяется, предложи коротко повторить. Называй что-то исправлением, только если ты действительно меняешь неправильную форму. '
            'Никогда не повторяй уже правильное предложение, выдавая его за исправление. Уважай диалектные и стилистические варианты. Если ты плохо расслышала, переспроси, а не угадывай.\n'
            'Отвечай коротко, задавая не больше одного вопроса. Не хвали каждый ответ. Мягко возражай против явно неверного утверждения. '
            'Учебные цели не важнее темы, которую выбрал собеседник. Дай время подумать; заговаривай во время паузы, только если об этом просит приложение.\n'
            'Когда собеседник меняет тему или просит другую, твоя следующая реплика должна быть одним коротким вопросом, подтверждающим смену. '
            'Дождись ответа, прежде чем говорить о новой теме. Сама просьба запускает это подтверждение, но не считается ответом. '
            'После подтверждения продолжай естественно, не спрашивая снова. Связанные детали подтверждения не требуют. Помни уже сказанные факты. '
            'Правильное предложение на другую тему не является языковой ошибкой.'),
    },
}


def policy_texts(core):
    """Per-language opening line and conversation rules from `TeachingPolicy.swift`."""
    text = (core / 'TeachingPolicy.swift').read_text()
    intro = re.search(r'private static func introduction\(language: LanguageModule\) -> String \{(.*?)\n    \}', text, re.S)
    guidance = re.search(r'private static func conversationGuidance\(language: LanguageModule\) -> String \{(.*?)\n    \}', text, re.S)
    if not intro or not guidance:
        raise SystemExit('TeachingPolicy.introduction or conversationGuidance not found in apps/ios/Core/TeachingPolicy.swift.')
    openings = {m.group(1): json.loads('"' + m.group(2) + '"')
                for m in re.finditer(r'case "(\w+)": "((?:[^"\\]|\\.)*)"', intro.group(1))}
    rules = {}
    for m in re.finditer(r'case "(\w+)":\n\s*"""\n(.*?)\n\s*"""', guidance.group(1), re.S):
        body = textwrap.dedent(m.group(2))
        if '\\' in body:
            raise SystemExit(f'conversationGuidance for {m.group(1)} contains a backslash; extend policy_texts to unescape it.')
        rules[m.group(1)] = body
    return openings, rules


def theme_dict(text):
    vals = swift_strings(text)
    color = int(re.search(r',\s*(\d+)\s*\)$', text).group(1))
    if len(vals) != 6:
        raise SystemExit(f'Unexpected ConversationTheme arguments {vals}; expected six strings and a color index.')
    keys = ('id', 'title', 'subtitle', 'symbol', 'category', 'situation')
    return {**dict(zip(keys, vals)), 'colorIndex': color}


def generate_web(core):
    """Render the versioned language content package for the web app."""
    registry_text = (core / 'Languages/LanguageModule.swift').read_text()
    known_fields = struct_fields(registry_text)
    simple_fields = [f for f in known_fields if f not in STRUCTURED_FIELDS]
    openings, rules = policy_texts(core)
    shared = [theme_dict(line.strip().removesuffix(',')[len('.init(') - 1:])
              for line in (core / 'Themes.swift').read_text().splitlines() if line.strip().startswith('.init(')]
    languages = []
    for path in language_files(core):
        text = path.read_text()
        entry = {}
        for key in simple_fields:
            match = re.search(r'\b' + key + r':\s*("(?:[^"\\]|\\.)*")', text)
            if not match:
                raise SystemExit(f'LanguageModule field {key} not found in {path}.')
            entry[key] = json.loads(match.group(1))
        focus_match = re.search(r'teachingFocus:\s*\[(.*?)\]', text, re.S)
        entry['teachingFocus'] = swift_strings(focus_match.group(1)) if focus_match else []
        if len(entry['teachingFocus']) != 6:
            raise SystemExit(f'{path} must define exactly six teachingFocus stages.')
        entry['themeOverrides'] = {m.group(1): theme_dict(m.group(2).removesuffix(','))
                                   for m in (re.match(r'\s*"([^"]+)":\s*\.init(.*)', line) for line in text.splitlines()) if m}
        lang = entry['id']
        supplement = WEB_SUPPLEMENTS.get(lang, {})
        supplemented = []
        for field, source in (('introduction', openings), ('conversationGuidance', rules)):
            if lang in source:
                entry[field] = source[lang]
            elif field in supplement:
                entry[field] = supplement[field]; supplemented.append(field)
            else:
                raise SystemExit(f'No {field} for language {lang}. Add it to TeachingPolicy.swift or WEB_SUPPLEMENTS.')
        # Fields written for the web package only; the apps have no text for them yet.
        entry['pendingNativeReview'] = supplemented
        languages.append(entry)
    return json.dumps({'version': WEB_PACK_VERSION, 'generatedBy': 'scripts/export_android_content.py',
                       'themes': shared, 'languages': languages}, ensure_ascii=False, indent=1) + '\n'


def generate(core):
    """Render `Languages.kt` from the Swift language content under `core`."""
    registry_text = (core / 'Languages/LanguageModule.swift').read_text()
    known_fields = struct_fields(registry_text)
    default_match = re.search(r'static let defaultID\s*=\s*"([^"]+)"', registry_text)
    if not default_match:
        raise SystemExit('LanguageRegistry.defaultID not found in Core/Languages/LanguageModule.swift.')
    default_id = default_match.group(1)
    simple_fields = [f for f in known_fields if f not in STRUCTURED_FIELDS]

    shared = (core / 'Themes.swift').read_text()
    shared_themes = [theme(line.strip().removesuffix(',')[len('.init(') - 1:])
                      for line in shared.splitlines() if line.strip().startswith('.init(')]
    lines = ['// Generated by scripts/export_android_content.py; edit the Swift language content.',
             'package chat.mural.core', '',
             'data class ConversationTheme(val id: String, val title: String, val subtitle: String, val symbol: String, val category: String, val situation: String, val colorIndex: Int)',
             'object Themes { val shared = listOf(', ',\n'.join('    ' + x for x in shared_themes), ') }', '',
             '''data class LanguageModule(
    val id: String, val name: String, val nativeName: String, val variety: String, val locale: String,
    val greeting: String, val greetingWord: String, val speechGuidance: String, val writingGuidance: String,
    val lemmaGuidance: String, val teachingFocus: List<String>, val topicPlaceholder: String,
    val lookupUnavailableReply: String, val themeOverrides: Map<String, ConversationTheme> = emptyMap()
) {
    val themes get() = Themes.shared.map { themeOverrides[it.id] ?: it }
    val defaultTitle get() = "A little $name"
    val talkTitle get() = "A little everyday $name"
    val settingsTitle get() = "$name · $variety"
}''', '', 'object LanguageRegistry {', f'    const val defaultID = {quoted(default_id)}']
    module_names = []
    for path in language_files(core):
        text = path.read_text()
        unknown = call_arguments(text) - set(known_fields)
        if unknown:
            raise SystemExit(
                f"Unknown LanguageModule field(s) {', '.join(sorted(unknown))} in {path}. "
                f"Declare them in apps/ios/Core/Languages/LanguageModule.swift and add support in {KOTLIN_DEST}.")
        module_name = path.stem.lower()
        module_names.append(module_name)
        args = []
        for key in simple_fields:
            match = re.search(r'\b' + key + r':\s*("(?:[^"\\]|\\.)*")', text)
            if not match:
                raise SystemExit(f'LanguageModule field {key} not found in {path}. Add it or update {KOTLIN_DEST}.')
            args.append(f'        {key} = {quoted(json.loads(match.group(1)))}')
        focus_match = re.search(r'teachingFocus:\s*\[(.*?)\]', text, re.S)
        focuses = swift_strings(focus_match.group(1)) if focus_match else []
        if len(focuses) != 6:
            raise SystemExit(f'{path} must define exactly six teachingFocus stages.')
        args.append('        teachingFocus = listOf(' + ', '.join(map(quoted, focuses)) + ')')
        overrides = []
        for line in text.splitlines():
            m = re.match(r'\s*"([^"]+)":\s*\.init(.*)', line)
            if m:
                overrides.append(quoted(m.group(1)) + ' to ' + theme(m.group(2).removesuffix(',')))
        args.append('        themeOverrides = mapOf(' + ',\n            '.join(overrides) + ')')
        lines += [f'    private val {module_name} = LanguageModule(', ',\n'.join(args), '    )']
    lines += [f'    val all = listOf({", ".join(module_names)})',
              '    fun get(id: String) = all.firstOrNull { it.id == id }', '}', '',
              'object MeaningLanguages {']
    lines += meaning_languages(registry_text)
    lines += ['}', '']
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    dest = args.root / KOTLIN_DEST
    web_dest = args.root / WEB_DEST
    core = args.root / 'apps/ios/Core'
    result, web_result = generate(core), generate_web(core)
    if args.check:
        if not dest.exists() or dest.read_text() != result:
            raise SystemExit('Android language content differs. Run python3 scripts/export_android_content.py')
        if not web_dest.exists() or web_dest.read_text() != web_result:
            raise SystemExit('Web language content differs. Run python3 scripts/export_android_content.py')
    else:
        dest.write_text(result)
        web_dest.parent.mkdir(parents=True, exist_ok=True)
        web_dest.write_text(web_result)


if __name__ == '__main__':
    main()
