using System.Security.Cryptography;

namespace Yap.Services;

/// <summary>
/// Word lists and generator for link codes ("color-animal-NNNN").
/// </summary>
/// <remarks>
/// Plain, short, unambiguous words only: a code gets read aloud or off another screen and
/// typed on a phone. Entries must be lowercase ASCII with no spaces or hyphens, because the
/// matcher strips everything else. Colors and animals must not overlap ("salmon" is an
/// animal here), or a code could read "salmon-salmon-1234".
///
/// Space: ~80 colors × ~300 animals × 9000 numbers ≈ 200 million. That is far below a random
/// token, and it is enough only together with the failure brake in AccessLinkService.
/// </remarks>
public static class AccessLinkCodes
{
    public static readonly string[] Colors =
    [
        "red", "blue", "green", "gold", "pink", "cyan", "lime", "teal", "plum", "mint",
        "ruby", "jade", "coral", "amber", "ivory", "peach", "sage", "navy", "rust", "wine",
        "aqua", "beige", "black", "bronze", "brown", "copper", "cream", "crimson", "gray", "indigo",
        "khaki", "lavender", "lemon", "lilac", "magenta", "maroon", "mauve", "olive", "orange", "pearl",
        "purple", "rose", "sand", "scarlet", "silver", "slate", "tan", "violet", "white", "yellow",
        "azure", "cobalt", "emerald", "honey", "mocha", "moss", "onyx", "opal", "pine", "sapphire",
        "sienna", "smoke", "steel", "sunset", "topaz", "ash", "berry", "cherry", "cocoa", "denim",
        "ember", "fern", "frost", "ginger", "hazel", "ice", "iris", "mustard", "orchid", "quartz",
        "snow",
    ];

    public static readonly string[] Animals =
    [
        "cat", "dog", "fox", "owl", "bee", "bat", "elk", "ant", "emu", "yak",
        "ape", "cod", "cow", "hen", "jay", "koi", "ram", "rat", "ray", "seal",
        "wolf", "bear", "deer", "frog", "hawk", "lion", "lynx", "moth", "puma", "swan",
        "badger", "beaver", "bison", "boar", "camel", "cheetah", "cobra", "crab", "crane", "crow",
        "dolphin", "donkey", "dove", "duck", "eagle", "eel", "falcon", "ferret", "finch", "gecko",
        "gibbon", "giraffe", "goat", "goose", "gorilla", "hamster", "hare", "heron", "hippo", "horse",
        "hyena", "ibis", "iguana", "jackal", "jaguar", "kiwi", "koala", "lemur", "leopard", "lizard",
        "llama", "lobster", "magpie", "mole", "monkey", "moose", "mouse", "mule", "newt", "ocelot",
        "octopus", "orca", "osprey", "otter", "oyster", "panda", "panther", "parrot", "pelican", "penguin",
        "pigeon", "pony", "possum", "quail", "rabbit", "raccoon", "raven", "rhino", "robin", "salmon",
        "shark", "sheep", "shrimp", "skunk", "sloth", "snail", "snake", "sparrow", "spider", "squid",
        "squirrel", "stork", "tiger", "toad", "trout", "tuna", "turkey", "turtle", "viper", "walrus",
        "wasp", "weasel", "whale", "wombat", "zebra", "alpaca", "antelope", "armadillo", "baboon", "bulldog",
        "buffalo", "bunny", "butterfly", "canary", "capybara", "caribou", "catfish", "chameleon", "chicken", "chinchilla",
        "chipmunk", "cockatoo", "condor", "corgi", "cougar", "coyote", "cricket", "dingo", "dragon", "dragonfly",
        "elephant", "firefly", "flamingo", "gazelle", "gerbil", "gnu", "goldfish", "grasshopper", "grizzly", "hedgehog",
        "hornet", "hummingbird", "husky", "jellyfish", "kangaroo", "kestrel", "kitten", "ladybug", "lark", "macaw",
        "mammoth", "manatee", "mantis", "meerkat", "mink", "mongoose", "narwhal", "nightingale", "okapi", "oriole",
        "ostrich", "ox", "parakeet", "peacock", "pheasant", "pig", "piglet", "piranha", "platypus", "poodle",
        "porcupine", "puffin", "puppy", "python", "reindeer", "rooster", "sardine", "scorpion", "seagull", "seahorse",
        "skylark", "starfish", "stingray", "swallow", "tapir", "termite", "tortoise", "toucan", "unicorn", "vulture",
        "wallaby", "warthog", "wildcat", "woodpecker", "wren", "yeti", "beagle", "bumblebee", "cardinal", "collie",
        "dachshund", "dalmatian", "gopher", "gosling", "greyhound", "jackdaw", "kingfisher", "lamb", "lionfish", "marmot",
        "minnow", "mustang", "bobcat", "calf", "chick", "cub", "doe", "duckling", "fawn", "foal",
        "gander", "gull", "hound", "joey", "mare", "pup", "stag", "tadpole", "terrier", "tomcat",
        "vixen", "colt", "filly", "bull", "hog", "ewe", "burro", "stallion", "spaniel", "retriever",
        "mastiff", "pug", "shepherd", "akita", "shiba", "samoyed", "tabby", "siamese", "sphynx", "bengal",
        "manx", "anchovy", "barracuda", "clam", "cuttlefish", "flounder", "guppy", "haddock", "halibut", "herring",
        "mackerel", "marlin", "mussel", "perch", "pike", "prawn", "sailfish", "scallop", "sturgeon", "swordfish",
        "tilapia", "urchin", "albatross", "bluebird", "cuckoo", "egret", "gannet", "goldfinch", "grouse", "kite",
        "loon", "mallard", "nuthatch", "partridge", "plover", "sandpiper", "snipe", "starling", "tern", "thrush",
        "warbler", "waxwing", "wagtail", "aardvark", "bandicoot", "bongo", "chamois", "civet", "dormouse", "dugong",
        "echidna", "ermine", "fennec", "ibex", "impala", "kudu", "lemming", "loris", "marten", "muskrat",
        "numbat", "oryx", "pangolin", "pika", "polecat", "quokka", "sable", "serval", "shrew", "stoat",
        "tamarin", "vole", "wolverine", "beetle", "cicada", "glowworm", "locust", "mayfly", "weevil", "silkworm",
        "alligator", "boa", "caiman", "crocodile", "skink", "terrapin",
    ];

    public static string Generate()
    {
        var color = Colors[RandomNumberGenerator.GetInt32(Colors.Length)];
        var animal = Animals[RandomNumberGenerator.GetInt32(Animals.Length)];
        var number = RandomNumberGenerator.GetInt32(1000, 10000);
        return $"{color}-{animal}-{number}";
    }
}
