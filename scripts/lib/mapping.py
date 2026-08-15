"""
Heuristic mappings derived from objective, publicly available SEC data
(SIC industry classification codes) rather than a paid ESG vendor.

SIC -> GICS-style sector and SIC -> sin-stock flags are inherently
approximate (SIC is a coarser, older classification than GICS), so these
are documented as derived/heuristic in the output dataset's metadata,
consistent with this project's "don't invent data labeled as verified"
convention.
"""

# (low, high, sector) ranges, checked in order; first match wins.
SIC_SECTOR_RANGES = [
    (100, 999, "Materials"),          # agriculture
    (1000, 1099, "Materials"),        # metal mining
    (1200, 1299, "Materials"),        # coal mining
    (1300, 1399, "Energy"),           # oil & gas extraction
    (1400, 1499, "Materials"),        # nonmetallic mining
    (1500, 1799, "Industrials"),      # construction
    (2000, 2199, "Consumer Staples"),  # food, beverages, tobacco
    (2200, 2399, "Consumer Discretionary"),  # textiles, apparel
    (2400, 2599, "Materials"),        # lumber, furniture
    (2600, 2699, "Materials"),        # paper
    (2700, 2799, "Communication Services"),  # printing & publishing
    (2800, 2824, "Materials"),        # industrial chemicals
    (2825, 2836, "Health Care"),      # pharma / biological products
    (2840, 2844, "Consumer Staples"),  # soap, detergents, cosmetics, perfumes (personal/household care)
    (2850, 2899, "Materials"),        # other chemicals
    (2900, 2999, "Energy"),           # petroleum refining
    (3000, 3099, "Materials"),        # rubber, plastics
    (3100, 3199, "Consumer Discretionary"),  # leather
    (3200, 3299, "Materials"),        # stone, clay, glass
    (3300, 3399, "Materials"),        # primary metals
    (3400, 3499, "Industrials"),      # fabricated metal products
    (3500, 3569, "Industrials"),      # industrial/commercial machinery
    (3570, 3579, "Information Technology"),  # computer & office equipment
    (3580, 3599, "Industrials"),      # refrigeration/service industry machinery
    (3600, 3699, "Information Technology"),  # electronic equipment, semiconductors
    (3700, 3711, "Consumer Discretionary"),  # motor vehicles
    (3712, 3799, "Industrials"),      # other transportation equipment
    (3800, 3812, "Industrials"),      # measuring instruments (general/industrial)
    (3812, 3812, "Industrials"),      # search/detection/navigation/guidance/aeronautical (defense)
    (3813, 3825, "Industrials"),      # industrial/electrical measuring instruments
    (3826, 3827, "Health Care"),      # laboratory analytical instruments, optical instruments
    (3828, 3829, "Industrials"),      # measuring/controlling devices NEC
    (3841, 3851, "Health Care"),      # surgical/medical/dental/ophthalmic instruments
    (3852, 3873, "Consumer Discretionary"),  # photographic equipment, watches/clocks
    (3880, 3999, "Consumer Discretionary"),  # misc manufacturing
    (4000, 4099, "Industrials"),      # railroads
    (4100, 4299, "Industrials"),      # transit, trucking
    (4300, 4399, "Industrials"),      # postal/couriers
    (4400, 4499, "Industrials"),      # water transportation
    (4500, 4599, "Industrials"),      # air transportation
    (4600, 4699, "Energy"),           # pipelines
    (4700, 4799, "Industrials"),      # transportation services
    (4800, 4899, "Communication Services"),  # communications
    (4900, 4999, "Utilities"),
    (5000, 5199, "Consumer Discretionary"),  # wholesale trade (durable)
    (5200, 5299, "Consumer Discretionary"),  # building materials retail
    (5300, 5399, "Consumer Staples"),  # general merchandise/variety stores (food+staples-heavy: Walmart, Target, dollar stores)
    (5400, 5499, "Consumer Staples"),  # food stores
    (5500, 5599, "Consumer Discretionary"),  # auto dealers
    (5600, 5699, "Consumer Discretionary"),  # apparel/accessory stores
    (5700, 5799, "Consumer Discretionary"),  # furniture/home furnishings
    (5800, 5899, "Consumer Discretionary"),  # eating & drinking places
    (5900, 5999, "Consumer Discretionary"),  # misc retail
    (6000, 6099, "Financials"),       # depository institutions
    (6100, 6199, "Financials"),       # non-depository credit
    (6200, 6299, "Financials"),       # security/commodity brokers
    (6300, 6499, "Financials"),       # insurance
    (6500, 6599, "Real Estate"),
    (6700, 6799, "Financials"),       # holding/investment offices
    (7000, 7099, "Consumer Discretionary"),  # hotels
    (7200, 7299, "Consumer Discretionary"),  # personal services
    (7300, 7369, "Industrials"),      # business services
    (7370, 7379, "Information Technology"),  # computer services
    (7380, 7399, "Industrials"),      # business services (other)
    (7500, 7599, "Consumer Discretionary"),  # auto services
    (7600, 7699, "Industrials"),      # repair services
    (7800, 7899, "Communication Services"),  # motion pictures
    (7900, 7999, "Consumer Discretionary"),  # amusement & recreation
    (8000, 8099, "Health Care"),      # health services
    (8100, 8199, "Industrials"),      # legal services
    (8200, 8299, "Consumer Discretionary"),  # educational services
    (8300, 8399, "Industrials"),      # social services
    (8600, 8699, "Industrials"),      # membership organizations
    (8700, 8799, "Industrials"),      # engineering/management services
    (8900, 8999, "Industrials"),      # misc services
    (9995, 9995, "Industrials"),      # non-classifiable
]

DEFAULT_SECTOR = "Industrials"

# Communication Services carve-outs for well-known media/software SIC codes
# that would otherwise fall in Information Technology under a pure range map.
COMM_SERVICES_SIC = {7812, 7819, 7822, 7829, 7830, 7841, 4832, 4833, 4841, 2711, 2721, 2731, 2732, 2741}


def sic_to_sector(sic):
    if sic is None:
        return DEFAULT_SECTOR
    if sic in COMM_SERVICES_SIC:
        return "Communication Services"
    for lo, hi, sector in SIC_SECTOR_RANGES:
        if lo <= sic <= hi:
            return sector
    return DEFAULT_SECTOR


# --- Sin-stock flags, derived from SIC industry classification -------------

TOBACCO_SIC = {2100, 2110, 2111, 2120, 2121, 2130, 2131, 2140, 2141}
ALCOHOL_SIC = {2080, 2082, 2083, 2084, 2085, 2086, 5180, 5181, 5182, 5813, 5921}
GAMBLING_SIC = {7993, 7999}
WEAPONS_DEFENSE_SIC = {3480, 3482, 3483, 3484, 3489, 3760, 3761, 3764, 3769, 3795, 3812}
GAMBLING_NAME_KEYWORDS = ("casino", "gaming", "wynn", "caesars", "draftkings", "lottery", "bet ", "betting")
ADULT_ENTERTAINMENT_NAME_KEYWORDS = ("playboy",)


def sin_stock_flags(sic, company_name):
    name_lower = (company_name or "").lower()
    tobacco = sic in TOBACCO_SIC
    alcohol = sic in ALCOHOL_SIC
    gambling = sic in GAMBLING_SIC or any(k in name_lower for k in GAMBLING_NAME_KEYWORDS)
    weapons_defense = sic in WEAPONS_DEFENSE_SIC
    # No SIC code cleanly identifies adult entertainment; there is no
    # reliable public per-company signal at this scale, so this defaults to
    # False (the safe default per the "don't invent data" rule) unless a
    # narrow, unambiguous name match applies.
    adult_entertainment = any(k in name_lower for k in ADULT_ENTERTAINMENT_NAME_KEYWORDS)
    return {
        "tobacco": tobacco,
        "alcohol": alcohol,
        "gambling": gambling,
        "weapons_defense": weapons_defense,
        "adult_entertainment": adult_entertainment,
    }


# Sectors where animal testing is a plausible regulatory/product reality
# (pharma, biotech, personal care/household products, some food/ag) get a
# "Medium" heuristic; everything else defaults to "Low". This is a
# sector-level heuristic, not a per-company verified fact -- flagged as
# such wherever it's used.
ANIMAL_TESTING_HIGHER_SIC_RANGES = [(2830, 2836), (2840, 2844), (8731, 8734)]


def animal_testing_exposure_text(sic, sector):
    higher = sic is not None and any(lo <= sic <= hi for lo, hi in ANIMAL_TESTING_HIGHER_SIC_RANGES)
    if higher or sector == "Health Care":
        return (
            "Medium (sector-level estimate) - pharmaceutical/health-care/personal-care sectors "
            "commonly involve regulatory-required or product-safety animal testing; no verified "
            "per-company data source available at this scale"
        )
    return (
        "Low (sector-level estimate) - sector does not typically require animal testing; "
        "no verified per-company data source available at this scale"
    )


def market_cap_tier(market_cap_millions):
    if market_cap_millions is None:
        return None
    billions = market_cap_millions / 1000.0
    if billions >= 200:
        return "Mega"
    if billions >= 10:
        return "Large"
    if billions >= 2:
        return "Mid"
    return "Small"


def leverage_level(liabilities, equity):
    if liabilities is None or equity is None or equity <= 0:
        return None
    ratio = liabilities / equity
    if ratio < 1.0:
        return "Low"
    if ratio <= 2.5:
        return "Medium"
    return "High"


def dividend_yield_tier(yield_pct):
    if yield_pct is None or yield_pct <= 0:
        return None
    if yield_pct < 1:
        return "Very Low"
    if yield_pct < 2:
        return "Low"
    if yield_pct < 4:
        return "Medium"
    return "High"


def hq_country_from_address(addr):
    if not addr:
        return "United States"
    business = addr.get("business") or {}
    if business.get("isForeignLocation"):
        country = business.get("stateOrCountryDescription") or business.get("stateOrCountry")
        if country:
            return country
    return "United States"
