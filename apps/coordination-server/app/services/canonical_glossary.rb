class CanonicalGlossary
  Section = Data.define(:title, :terms)
  Term = Data.define(:title, :anchor, :blocks)
  Inline = Data.define(:text, :code)
  Block = Data.define(:kind, :parts, :items)

  def self.load
    new(source_path.read).sections
  end

  def self.source_path
    [
      Pathname.new("/docs/architecture/glossary.md"),
      Rails.root.join("../../docs/architecture/glossary.md").expand_path
    ].find(&:file?) || raise("The canonical architecture glossary is unavailable.")
  end

  def initialize(source)
    @source = source
  end

  def sections
    parsed_sections = []
    current_section = nil
    current_term = nil
    definition_lines = []

    @source.each_line(chomp: true) do |line|
      if (section_match = line.match(/^# \d+\. (.+)$/))
        append_term(current_section, current_term, definition_lines)
        current_section = Section.new(title: section_match[1], terms: [])
        parsed_sections << current_section
        current_term = nil
        definition_lines = []
      elsif (term_match = line.match(/^## (.+)$/))
        append_term(current_section, current_term, definition_lines)
        current_term = term_match[1]
        definition_lines = []
      elsif current_term
        definition_lines << line
      end
    end

    append_term(current_section, current_term, definition_lines)
    parsed_sections.select { |section| section.terms.any? }
  end

  private

  def append_term(section, title, lines)
    return if section.nil? || title.nil?

    section.terms << Term.new(
      title: title,
      anchor: title.parameterize,
      blocks: parse_blocks(lines)
    )
  end

  def parse_blocks(lines)
    blocks = []
    paragraph = []
    list = []
    flush = lambda do
      unless paragraph.empty?
        blocks << Block.new(kind: :paragraph, parts: inline_parts(paragraph.join(" ")), items: [])
        paragraph = []
      end
      unless list.empty?
        blocks << Block.new(kind: :list, parts: [], items: list.map { |item| inline_parts(item) })
        list = []
      end
    end

    lines.each do |line|
      if line.empty?
        flush.call
      elsif line.start_with?("- ")
        unless paragraph.empty?
          blocks << Block.new(kind: :paragraph, parts: inline_parts(paragraph.join(" ")), items: [])
          paragraph = []
        end
        list << line.delete_prefix("- ")
      else
        unless list.empty?
          blocks << Block.new(kind: :list, parts: [], items: list.map { |item| inline_parts(item) })
          list = []
        end
        paragraph << line
      end
    end
    flush.call
    blocks
  end

  def inline_parts(text)
    text.split(/(`[^`]+`)/).reject(&:empty?).map do |part|
      code = part.start_with?("`") && part.end_with?("`")
      Inline.new(text: code ? part[1..-2] : part, code:)
    end
  end
end
