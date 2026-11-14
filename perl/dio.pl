#!/usr/bin/env perl
# JSON shim over the Diogenes Perl modules bundled with Diogenes.app.
# Reads one JSON request on stdin, writes one JSON response on stdout.
use strict;
use warnings;
use JSON::PP;
use Encode;
use File::Spec;

my ($SERVER, $DATA);
BEGIN {
    $SERVER = $ENV{DIOGENES_SERVER_DIR}
        || '/Applications/Diogenes.app/Contents/server';
    $DATA = $ENV{DIOGENES_DATA_DIR}
        || File::Spec->catdir($SERVER, '..', 'dependencies', 'data');
    unshift @INC, $SERVER, File::Spec->catdir($SERVER, '..', 'dependencies', 'CPAN');
}

# Keep the real stdout for our JSON; anything Diogenes prints directly to
# STDOUT outside a capture goes to stderr.
open(my $REAL, '>&', \*STDOUT) or die $!;
open(STDOUT, '>&', \*STDERR) or die $!;
binmode $REAL, ':raw';

require Diogenes::Base;
require Diogenes::Search;
require Diogenes::Indexed;
require Diogenes::Browser;
require Diogenes::UnicodeInput;

# Makes search output carry machine-readable ~~~type,auth,work:loc~~~ markers.
{ no warnings "once"; $Diogenes::Base::cgi_flag = 1; }

my $json = JSON::PP->new->utf8->canonical;
my $req = eval { local $/; $json->decode(scalar <STDIN>) };
reply({ error => "bad request: $@" }) unless ref $req eq 'HASH';

my %ops = (
    authors     => \&op_authors,
    works       => \&op_works,
    search      => \&op_search,
    word_list   => \&op_word_list,
    morph       => \&op_morph,
    lemmata     => \&op_lemmata,
    parse       => \&op_parse,
    define      => \&op_define,
    read        => \&op_read,
    corpora     => \&op_corpora,
    save_corpus => \&op_save_corpus,
    delete_corpus => \&op_delete_corpus,
);
my $op = $ops{ $req->{op} || '' }
    or reply({ error => "unknown op: " . ($req->{op} // '') });
my $res = eval { $op->($req) };
reply({ error => "$@" }) if $@;
reply($res);

sub reply {
    print $REAL $json->encode($_[0]);
    exit 0;
}

##### helpers

sub base_args {
    my %a = (
        type           => 'tlg',
        encoding       => 'UTF-8',
        output_format  => 'ascii',
        input_encoding => 'Unicode',
        highlight      => 1,
        chunk_size     => 30_000_000,
    );
    return (%a, @_);
}

sub capture {
    my $code = shift;
    my $buf  = '';
    open(my $fh, '>', \$buf) or die $!;
    my $old = select $fh;
    my @rv = eval { $code->() };
    my $err = $@;
    select $old;
    close $fh;
    die $err if $err;
    my $o = Encode::decode("UTF-8", $buf);
    $o =~ s/[\x00-\x08]//g;
    return ($o, @rv);
}

sub txt {    # Diogenes hands back utf8 bytes
    my $s = shift;
    return undef unless defined $s;
    $s = Encode::decode('UTF-8', $s) unless utf8::is_utf8($s);
    $s =~ s/[\x00-\x08]//g;
    return $s;
}

my $FMT;
sub beta2uni {    # beta code word -> unicode
    my $s = uc shift;
    $FMT ||= Diogenes::Base->new(base_args());
    $FMT->{perseus_morph} = 0;
    $FMT->format_output(\$s, 'g', 1);
    $s = txt($s);
    $s =~ s/^\s+|\s+$//g;
    return $s;
}

sub uni2beta {    # unicode word -> lowercase beta code (as in the Perseus data)
    my $w = shift;
    return lc $w if $w =~ /^[\x20-\x7e]+$/;    # already beta
    $FMT ||= Diogenes::Base->new(base_args());
    my $b = Diogenes::UnicodeInput::unicode_greek_to_beta($FMT, $w);
    die "could not convert '$w' to beta code\n" unless defined $b;
    $b = lc $b;
    $b =~ s/^\s+|\s+$//g;
    $b =~ s/\\/\//g;    # grave -> acute
    return $b;
}

sub bare { my $s = lc shift; $s =~ s/[^a-z]//g; return $s }

sub corpora_file { Diogenes::Base->new(base_args())->{filter_file} }

sub load_corpora {
    my $f = corpora_file();
    return [] unless -e $f;
    open(my $fh, '<:raw', $f) or die "can't read $f: $!";
    local $/;
    my $c = eval { JSON::PP->new->utf8->decode(scalar <$fh>) } || [];
    return $c;
}

# scope: { corpus => name } | { authors => [nums] | { num => [works] } }
#        | { author_regex => str } | nothing (whole TLG)
sub apply_scope {
    my ($q, $r) = @_;
    my @texts;
    if (defined $r->{corpus}) {
        my ($c) = grep { lc $_->{name} eq lc $r->{corpus} } @{ load_corpora() };
        die "no saved corpus named '$r->{corpus}'\n" unless $c;
        die "corpus '$c->{name}' is type $c->{type}, only tlg is supported\n"
            unless $c->{type} eq 'tlg';
        @texts = $q->select_authors(author_nums => $c->{authors});
    }
    elsif ($r->{authors}) {
        @texts = $q->select_authors(author_nums => $r->{authors});
    }
    elsif (defined $r->{author_regex}) {
        @texts = $q->select_authors(author_regex => $r->{author_regex});
        die "no authors match '$r->{author_regex}'\n" unless @texts;
    }
    else { return ['(entire TLG)'] }
    return [ map { txt($_) } @texts ];
}

# Split captured search output into hits.
sub parse_hits {
    my ($out) = @_;
    my @hits;
    my @parts = split /~~~([a-z]+,[^~\n]+)~~~\n?/, $out;
    my $tail = pop @parts;    # totals etc.
    while (@parts) {
        my $body = shift @parts;
        my $jump = shift @parts;
        $jump =~ s/[\x{b7}\x{387}]/:/g;
        $body =~ s/^\s+//;
        my ($head, $text) = split /\n\s*\n/, $body, 2;
        $text = '' unless defined $text;
        $head =~ s/\s+\n/\n/g;
        my @hl = split /\n/, $head;
        my $cit = pop @hl;
        my ($type, $auth, $rest) = split /,/, $jump, 3;
        my ($work, @loc) = split /:/, $rest;
        $text =~ s/\s+$//;
        my $n = () = $text =~ /->.*?<-/gs;
        push @hits, {
            author   => $auth,
            work     => $work,
            title    => join(' ', @hl),
            citation => $cit,
            location => \@loc,
            jump     => $jump,
            matches  => $n,
            text     => $text,
        };
    }
    return (\@hits, $tail);
}

sub page {
    my ($hits, $r) = @_;
    my $off = $r->{offset} || 0;
    my $lim = defined $r->{limit} ? $r->{limit} : 20;
    my %by_work;
    my $matches = 0;
    for (@$hits) {
        my $k = "$_->{author}:$_->{work}";
        $by_work{$k}{passages}++;
        $by_work{$k}{matches} += $_->{matches};
        $by_work{$k}{title} ||= $_->{title};
        $matches += $_->{matches};
    }
    my $n = scalar @$hits;
    my $last = $off + $lim - 1;
    $last = $n - 1 if $last > $n - 1;
    my @slice = $off <= $last ? @{$hits}[ $off .. $last ] : ();
    if ($r->{count_only}) { @slice = () }
    return (
        passages            => $n,
        highlighted_matches => $matches,
        by_work             => \%by_work,
        offset              => $off,
        returned            => scalar @slice,
        hits                => \@slice,
    );
}

##### ops

sub op_authors {
    my $r = shift;
    my $q = Diogenes::Browser->new(base_args());
    my %a = $q->browse_authors($r->{pattern} // '');
    return { authors => [ map { { num => $_, name => txt($a{$_}) } } sort keys %a ] };
}

sub op_works {
    my $r = shift;
    my $q = Diogenes::Browser->new(base_args());
    my $auth = sprintf '%04d', $r->{author};
    my %w = $q->browse_works($auth);
    my @works;
    for my $n (sort keys %w) {
        my @labels = map { txt($_) } $q->browse_location($auth, $n);
        push @works, { num => $n, title => txt($w{$n}), levels => \@labels };
    }
    return { author => $auth, works => \@works };
}

sub op_search {
    my $r = shift;
    my @pats = ref $r->{patterns} ? @{ $r->{patterns} } : ($r->{pattern});
    die "no pattern given\n" unless @pats and defined $pats[0];
    my %a = base_args(pattern_list => [@pats]);
    $a{context}        = $r->{context}     if $r->{context};
    $a{min_matches}    = $r->{min_matches} if $r->{min_matches};
    $a{reject_pattern} = $r->{reject}      if $r->{reject};
    my $q = Diogenes::Search->new(%a);
    die "TLG database not found\n" unless ref $q and $q->check_db;
    my $scope = apply_scope($q, $r);
    my ($out, $rv) = capture(sub { $q->do_search });
    my ($hits) = parse_hits($out);
    return {
        scope     => $scope,
        truncated => (defined $rv and $rv eq 'done') ? JSON::PP::false : JSON::PP::true,
        page($hits, $r),
    };
}

sub op_word_list {
    my $r = shift;
    my $q = Diogenes::Indexed->new(base_args());
    die "TLG database not found\n" unless ref $q and $q->check_db;
    my $scope = apply_scope($q, $r);
    my ($ref, @wl) = $q->read_index($r->{pattern});
    my $lim = $r->{limit} || 200;
    my @words;
    for my $w (@wl) {
        push @words, { beta => $w, word => beta2uni($w), count => ($ref->{$w} || 0) + 0 };
    }
    my $total = 0;
    $total += $_->{count} for @words;
    return {
        scope => $scope,
        distinct_forms => scalar @words,
        total_count    => $total,
        words          => [ @words > $lim ? @words[ 0 .. $lim - 1 ] : @words ],
    };
}

# Lemma line: lemma \t lsj_offset \t form (analysis)... \t form ...
sub lemma_lines {
    my ($want) = @_;    # sub returning true for a matching lemma key
    my $file = File::Spec->catfile($DATA, 'greek-lemmata.txt');
    open(my $fh, '<:raw', $file) or die "can't open $file: $!";
    my @found;
    while (my $line = <$fh>) {
        my $t = index($line, "\t");
        next if $t < 0;
        my $key = substr($line, 0, $t);
        next unless $want->($key);
        chomp $line;
        my ($lem, $off, @forms) = split /\t/, $line;
        push @found, {
            lemma_beta => $lem,
            lemma      => beta2uni($lem),
            lsj_offset => $off + 0,
            forms      => [
                map {
                    my ($f, $an) = /^(\S+)\s*(.*)$/;
                    { beta => $f, form => beta2uni($f), analysis => $an }
                } @forms
            ],
        };
    }
    return @found;
}

sub analyses_for {
    my ($beta) = @_;
    my $file = File::Spec->catfile($DATA, 'greek-analyses.txt');
    open(my $fh, '<:raw', $file) or die "can't open $file: $!";
    my $pre = "$beta\t";
    my $len = length $pre;
    my @out;
    while (my $line = <$fh>) {
        next unless substr($line, 0, $len) eq $pre;
        while ($line =~ /\{(\d+) \d+ ([^\t}]*)\t([^\t}]*)\t([^}]*)\}/g) {
            my ($off, $lem, $gloss, $an) = ($1, $2, $3, $4);
            $lem =~ s/^.*,//;
            push @out, {
                lemma_beta => $lem, lemma => beta2uni($lem),
                gloss => $gloss, analysis => $an, lsj_offset => $off + 0,
            };
        }
        last;
    }
    return @out;
}

# Find candidate lemmata for a word (a dictionary form or any inflected form).
sub find_lemmata {
    my ($word) = @_;
    my $beta = uni2beta($word);
    my $accented = $beta =~ /[^a-z]/;
    my $b = bare($beta);
    my %keys;
    # 1. the word is itself a headword
    my @l = lemma_lines(sub {
        my $k = shift; $k =~ s/\d+$//;
        return $accented ? lc $k eq $beta : bare($k) eq $b;
    });
    $keys{ $_->{lemma_beta} }++ for @l;
    # 2. the word is an inflected form
    if ($accented) {
        my %want = map { $_->{lemma_beta} => 1 } analyses_for($beta);
        delete $want{$_} for keys %keys;
        push @l, lemma_lines(sub { $want{ $_[0] } }) if %want;
    }
    return @l;
}

sub op_lemmata {
    my $r = shift;
    my @l = find_lemmata($r->{word});
    return { query => $r->{word}, lemmata => \@l };
}

sub op_parse {
    my $r = shift;
    my $beta = uni2beta($r->{word});
    my @a = analyses_for($beta);
    return { word => $r->{word}, beta => $beta, analyses => \@a };
}

sub lsj_entry {
    my ($off) = @_;
    my $file = File::Spec->catfile($DATA, 'grc.lsj.xml');
    open(my $fh, '<:raw', $file) or die "can't open $file: $!";
    seek $fh, $off, 0;
    my $e = <$fh>;
    $e = Encode::decode('UTF-8', $e);
    $e =~ s/<bibl[^>]*>/ /g;
    $e =~ s/<sense[^>]*\bn="([^"]*)"[^>]*>/\n$1. /g;
    $e =~ s/<[^>]+>//g;
    $e =~ s/&lt;/</g; $e =~ s/&gt;/>/g; $e =~ s/&amp;/&/g;
    $e =~ s/[ \t]+/ /g;
    $e =~ s/\n\. /\n/g;
    $e =~ s/^\s+|\s+$//g;
    return $e;
}

sub op_define {
    my $r = shift;
    my @l = find_lemmata($r->{word});
    my $max = $r->{max_chars} || 6000;
    my (%seen, @entries);
    for (@l) {
        next if $seen{ $_->{lsj_offset} }++;
        my $e = lsj_entry($_->{lsj_offset});
        my $trunc = length $e > $max;
        $e = substr($e, 0, $max) if $trunc;
        push @entries, {
            lemma => $_->{lemma}, lemma_beta => $_->{lemma_beta},
            entry => $e, truncated => $trunc ? JSON::PP::true : JSON::PP::false,
        };
    }
    return { word => $r->{word}, entries => \@entries };
}

# Morphological search: every inflected form of the chosen lemma(ta), run
# through the TLG word index, as the app's "Inflected Forms" search does.
sub op_morph {
    my $r = shift;
    my @forms;
    my @lem;
    if ($r->{forms}) {
        @forms = map { uni2beta($_) } @{ $r->{forms} };
    }
    else {
        @lem = find_lemmata($r->{lemma});
        if ($r->{lemma_beta}) {
            @lem = grep { $_->{lemma_beta} eq $r->{lemma_beta} } @lem;
        }
        die "no lemma found for '$r->{lemma}'\n" unless @lem;
        if (@lem > 1 and not $r->{all_lemmata}) {
            return {
                ambiguous => JSON::PP::true,
                message   => 'Several lemmata match; pass lemma_beta to pick one, or all_lemmata=true.',
                lemmata   => [ map { { lemma => $_->{lemma}, lemma_beta => $_->{lemma_beta},
                                       forms => scalar @{ $_->{forms} } } } @lem ],
            };
        }
        my $filter = $r->{form_filter};
        for my $l (@lem) {
            for my $f (@{ $l->{forms} }) {
                next if $filter and index($f->{analysis}, $filter) < 0;
                push @forms, $f->{beta};
            }
        }
    }
    my %u;
    @forms = grep { !$u{$_}++ } map { my $f = uc $_; $f =~ s/\\/\//g; $f } @forms;
    die "no forms to search for\n" unless @forms;

    my %a = base_args(use_tlgwlinx => 1);
    $a{context} = $r->{context} if $r->{context};
    my $q = Diogenes::Indexed->new(%a);
    die "TLG database not found\n" unless ref $q and $q->check_db;
    my $scope = apply_scope($q, $r);

    # Which of the forms actually occur in the TLG word list (within scope)?
    $q->{input_raw} = 1;
    my (%attested, %done);
    for my $f (@forms) {
        my $b = $f; $b =~ s/[^A-Z]//g;
        next if $done{$b}++;
        my ($ref, @wl) = $q->read_index($b);
        $attested{$_} = $ref->{$_} for @wl;
    }
    my @found = grep { exists $attested{$_} } @forms;
    my %form_counts;
    for my $w (@found) { $form_counts{ beta2uni($w) } = $attested{$w} + 0 }
    my $index_total = 0;
    $index_total += $_ for values %form_counts;

    my %res = (
        scope        => $scope,
        lemmata      => [ map { $_->{lemma} } @lem ],
        forms_tried  => scalar @forms,
        forms_found  => \%form_counts,
        forms_beta   => \@found,
        word_index_total => $index_total,
    );
    return { %res } if $r->{forms_only};
    unless (@found) {
        return { %res, passages => 0, highlighted_matches => 0, hits => [] };
    }
    my ($out, $rv) = capture(sub { $q->do_search(map { [$_] } @found) });
    my ($hits) = parse_hits($out);
    return {
        %res,
        truncated => (defined $rv and $rv eq 'done') ? JSON::PP::false : JSON::PP::true,
        page($hits, $r),
    };
}

sub op_read {
    my $r = shift;
    my $lines = $r->{lines} || 40;
    my %a = base_args(browse_lines => $lines, highlight => 0);
    my $q = Diogenes::Browser->new(%a);
    die "TLG database not found\n" unless ref $q and $q->check_db;
    my $auth = sprintf '%04d', $r->{author};
    my $work = sprintf '%03d', $r->{work};
    my @labels = $q->browse_location($auth, $work);
    my @target = @{ $r->{location} || [] };
    # Pad on the right: unspecified lower levels start at the beginning.
    my @real = grep { !/^\*/ } @labels;
    push @target, 0 while @target < @real;
    my ($out) = capture(sub {
        $q->seek_passage($auth, $work, @target);
        $q->browse_forward;
    });
    $out =~ s/\x02//g;
    return {
        author => $auth, work => $work,
        levels => [ map { txt($_) } @real ],
        location => \@target,
        text => $out,
    };
}

sub op_corpora {
    return { file => corpora_file(), corpora => load_corpora() };
}

sub write_corpora {
    my $c = shift;
    my $f = corpora_file();
    open(my $fh, '>:raw', $f) or die "can't write $f: $!";
    print $fh JSON::PP->new->utf8->canonical->encode($c);
    close $fh or die $!;
}

sub op_save_corpus {
    my $r = shift;
    die "name required\n" unless defined $r->{name} and length $r->{name};
    die "authors required\n" unless ref $r->{authors};
    my $auths;
    if (ref $r->{authors} eq 'ARRAY') {
        $auths = [ map { sprintf '%04d', $_ } @{ $r->{authors} } ];
    }
    else {
        for my $k (keys %{ $r->{authors} }) {
            my $v = $r->{authors}{$k};
            $auths->{ sprintf '%04d', $k } =
                ref $v ? [ map { sprintf '%03d', $_ } @$v ] : 'all';
        }
        # Diogenes wants a plain list when no works are singled out
        $auths = [ sort keys %$auths ] unless grep { ref } values %$auths;
    }
    # validate against the database
    my $q = Diogenes::Search->new(base_args(pattern_list => ['x']));
    my @texts = $q->select_authors(author_nums => $auths);
    die "no texts selected\n" unless @texts;
    my $c = load_corpora();
    my ($old) = grep { lc $_->{name} eq lc $r->{name} } @$c;
    die "corpus '$r->{name}' already exists; pass overwrite=true\n"
        if $old and not $r->{overwrite};
    @$c = grep { lc $_->{name} ne lc $r->{name} } @$c;
    push @$c, { name => $r->{name}, type => 'tlg', authors => $auths };
    write_corpora($c);
    return { saved => $r->{name}, texts => [ map { txt($_) } @texts ] };
}

sub op_delete_corpus {
    my $r = shift;
    my $c = load_corpora();
    my @keep = grep { lc $_->{name} ne lc $r->{name} } @$c;
    die "no saved corpus named '$r->{name}'\n" if @keep == @$c;
    write_corpora(\@keep);
    return { deleted => $r->{name} };
}
