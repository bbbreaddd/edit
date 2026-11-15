<script setup lang="ts">
import { computed } from 'vue'
import { useSearchModal } from '../../search/useSearchModal'
import { sanitizeRichHtml, sanitizeSearchHtml } from '../composables/sanitize'

defineEmits<{ (e: 'close'): void }>()
const {
  RESULTS_PAGE_SIZE,
  show,
  close,
  el,
  resultsEl,
  isFuzzySearch,
  isUrlSearch,
  activeCategory,
  categoryCounts,
  totalCategoryCount,
  visibleCategories,
  activeCategoryLabel,
  selectCategory,
  onCategoryWheel,
  filterText,
  urlSearchAuto,
  showDetailedList,
  disableDetailedView,
  buttonText,
  results,
  totalResultsCount,
  resultMarks,
  currentMarkIndex,
  enableNoResults,
  isSearching,
  resultLimit,
  mayHaveMore,
  recentSearches,
  autoSuggestions,
  cycleMatch,
  searchInput,
  applySuggestion,
  onSearchBarClick,
  selectedIndex,
  disableMouseOver,
  translate,
  customTitles,
  removeRecentSearch,
  clearAllRecentSearches,
  handleResultClick,
  resetSearch,
  handleInput,
  onMouseMove,
  onResultsKeydown
} = useSearchModal()

const renderedResults = computed(() =>
  results.value.map((result) => ({
    ...result,
    titleHtml: sanitizeSearchHtml(result.title),
    titlesHtml: result.titles.map(sanitizeSearchHtml),
    textHtml: showDetailedList.value ? sanitizeRichHtml(result.text) : ''
  }))
)
</script>

<template>
  <Teleport to="body">
    <Transition
      name="vp-local-search"
      appear
      :duration="150"
      @after-leave="$emit('close')"
    >
      <div
        v-if="show"
        ref="el"
        role="button"
        :aria-owns="results?.length ? 'localsearch-list' : undefined"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-labelledby="localsearch-label"
        class="VPLocalSearchBox"
      >
        <div class="backdrop" @click="close" />

        <div class="shell">
          <form
            class="search-bar"
            @pointerup="onSearchBarClick($event)"
            @submit.prevent
          >
            <label
              id="localsearch-label"
              :title="buttonText"
              for="localsearch-input"
            >
              <span
                aria-hidden="true"
                class="vpi-search search-icon local-search-icon"
              />
            </label>
            <div class="search-actions before">
              <button
                class="back-button"
                :title="translate('modal.backButtonTitle')"
                @click="close"
              >
                <span class="vpi-arrow-left local-search-icon" />
              </button>
            </div>
            <input
              id="localsearch-input"
              ref="searchInput"
              :value="filterText"
              :aria-activedescendant="
                selectedIndex > -1
                  ? 'localsearch-item-' + selectedIndex
                  : undefined
              "
              aria-autocomplete="both"
              :aria-controls="results?.length ? 'localsearch-list' : undefined"
              aria-labelledby="localsearch-label"
              autocapitalize="off"
              autocomplete="off"
              autocorrect="off"
              class="search-input"
              enterkeyhint="go"
              maxlength="256"
              :placeholder="buttonText"
              spellcheck="false"
              type="search"
              @input="handleInput"
            />
            <div class="search-actions">
              <span
                v-if="isSearching"
                class="vp-search-spinner"
                style="align-self: center; margin: 0 4px"
                :title="customTitles.searching"
              />

              <button
                class="toggle-fuzzy-button"
                type="button"
                :class="{ 'fuzzy-active': isFuzzySearch }"
                :aria-pressed="isFuzzySearch"
                :title="
                  isFuzzySearch ? customTitles.fuzzyOn : customTitles.fuzzyOff
                "
                @click="isFuzzySearch = !isFuzzySearch"
              >
                <span v-if="isFuzzySearch" class="fuzzy-icon">~</span>
                <span v-else class="exact-icon">=</span>
                <span class="visually-hidden">
                  {{
                    isFuzzySearch
                      ? 'Fuzzy Search Active'
                      : 'Exact Search Active'
                  }}
                </span>
              </button>

              <button
                class="toggle-url-button"
                type="button"
                :class="{
                  'url-active': isUrlSearch,
                  'url-auto': urlSearchAuto
                }"
                :aria-pressed="isUrlSearch"
                :title="
                  isUrlSearch
                    ? customTitles.urlOn
                    : urlSearchAuto
                      ? customTitles.urlAuto
                      : customTitles.urlOff
                "
                @click="isUrlSearch = !isUrlSearch"
              >
                <span class="url-icon i-lucide:link" />
                <span class="visually-hidden">
                  {{
                    isUrlSearch
                      ? 'URL Search Active'
                      : urlSearchAuto
                        ? 'URL Search Auto-Active'
                        : 'URL Search Off'
                  }}
                </span>
              </button>

              <button
                class="clear-button"
                type="reset"
                :disabled="!filterText"
                :title="translate('modal.resetButtonTitle')"
                @click="resetSearch"
              >
                <span class="vpi-delete local-search-icon" />
              </button>
            </div>
          </form>

          <div v-if="filterText" class="results-header">
            <span v-if="results.length" class="results-info-text">
              Showing {{ results.length }} of {{ totalResultsCount
              }}{{ mayHaveMore ? '+' : '' }} matches
            </span>
            <button
              v-if="!disableDetailedView"
              class="toggle-layout-button"
              type="button"
              :class="{ 'detailed-list': showDetailedList }"
              :aria-pressed="showDetailedList"
              :title="translate('modal.displayDetails')"
              @click="showDetailedList = !showDetailedList"
            >
              <span class="vpi-layout-list toggle-layout-icon" />
              <span class="toggle-layout-label">
                {{
                  showDetailedList
                    ? customTitles.detailedViewOn
                    : customTitles.detailedViewOff
                }}
              </span>
            </button>
          </div>

          <div
            v-if="filterText && visibleCategories.length"
            class="category-filters"
            @wheel="onCategoryWheel"
          >
            <button
              type="button"
              class="category-chip"
              :class="{ active: !activeCategory }"
              :aria-pressed="!activeCategory"
              title="All sections"
              @click="selectCategory('')"
            >
              All
              <span class="chip-count">{{ totalCategoryCount }}</span>
            </button>
            <button
              v-for="cat in visibleCategories"
              :key="cat.id"
              type="button"
              class="category-chip"
              :class="{ active: activeCategory === cat.id }"
              :aria-pressed="activeCategory === cat.id"
              :title="cat.label"
              @click="selectCategory(cat.id)"
            >
              {{ cat.label }}
              <span class="chip-count">
                {{ categoryCounts.get(cat.id) ?? 0 }}
              </span>
            </button>
          </div>

          <ul
            :id="results?.length ? 'localsearch-list' : undefined"
            ref="resultsEl"
            :role="results?.length ? 'listbox' : undefined"
            :aria-labelledby="results?.length ? 'localsearch-label' : undefined"
            class="results"
            tabindex="-1"
            @mousemove="onMouseMove"
            @keydown="onResultsKeydown"
          >
            <TransitionGroup name="result-list">
              <li
                v-for="(p, index) in renderedResults"
                :id="'localsearch-item-' + index"
                :key="p.id"
                :data-id="p.id"
                :aria-selected="selectedIndex === index ? 'true' : 'false'"
                role="option"
                class="result-item"
                :data-index="index"
              >
                <div
                  class="result"
                  :class="{
                    selected: selectedIndex === index
                  }"
                  @mouseenter="!disableMouseOver && (selectedIndex = index)"
                  @focusin="selectedIndex = index"
                  @click="handleResultClick($event, p.id)"
                >
                  <div>
                    <div class="titles">
                      <span class="title-icon">#</span>
                      <span
                        v-for="(titleHtml, titleIndex) in p.titlesHtml"
                        :key="titleIndex"
                        class="title"
                      >
                        <span class="text" v-html="titleHtml" />
                        <span class="vpi-chevron-right local-search-icon" />
                      </span>
                      <span class="title main">
                        <a
                          :href="p.id"
                          class="result-link"
                          :aria-label="[...p.titles, p.title].join(' > ')"
                        >
                          <span class="text" v-html="p.titleHtml" />
                        </a>
                      </span>
                    </div>
                    <div v-if="showDetailedList" class="excerpt-wrapper">
                      <div v-if="p.text" class="excerpt" inert>
                        <div class="vp-doc" v-html="p.textHtml" />
                      </div>

                      <div class="excerpt-gradient-bottom" />
                      <div class="excerpt-gradient-top" />
                      <Transition name="match-actions-fade">
                        <div
                          v-if="(resultMarks.get(index)?.length ?? 0) > 1"
                          class="excerpt-actions"
                          @click.stop.prevent
                        >
                          <button
                            type="button"
                            class="match-nav-button"
                            :title="customTitles.prevMatch"
                            @click.stop.prevent="cycleMatch(index, -1)"
                          >
                            <span class="vpi-chevron-left navigate-icon" />
                          </button>
                          <span class="match-count">
                            {{ (currentMarkIndex.get(index) ?? 0) + 1 }}/{{
                              resultMarks.get(index)?.length
                            }}
                          </span>
                          <button
                            type="button"
                            class="match-nav-button"
                            :title="customTitles.nextMatch"
                            @click.stop.prevent="cycleMatch(index, 1)"
                          >
                            <span class="vpi-chevron-right navigate-icon" />
                          </button>
                        </div>
                      </Transition>
                    </div>
                  </div>
                </div>
              </li>
              <li
                v-if="
                  filterText &&
                  !results.length &&
                  !isSearching &&
                  enableNoResults
                "
                key="no-results"
                class="no-results"
              >
                <div
                  v-if="activeCategory && totalCategoryCount > 0"
                  class="no-results-category"
                >
                  No results in {{ activeCategoryLabel }}
                  <button
                    class="try-fuzzy-btn"
                    @click="selectCategory(activeCategory)"
                  >
                    Show all sections
                  </button>
                </div>
                <div v-else>
                  {{ translate('modal.noResultsText') }} "{{ filterText }}"
                </div>
                <div v-if="!isFuzzySearch" class="no-results-actions">
                  <button class="try-fuzzy-btn" @click="isFuzzySearch = true">
                    Try fuzzy search?
                  </button>
                  <template v-if="autoSuggestions.length">
                    <span class="did-you-mean">Did you mean:</span>
                    <button
                      v-for="s in autoSuggestions"
                      :key="s"
                      class="suggestion-btn"
                      @click="applySuggestion(s)"
                    >
                      {{ s }}
                    </button>
                  </template>
                </div>
              </li>
              <li
                v-if="!filterText && recentSearches.length"
                key="recent-searches"
                class="recent-searches"
              >
                <div class="recent-header">
                  <span class="recent-label">Recent</span>
                  <button class="clear-all-btn" @click="clearAllRecentSearches">
                    Clear all
                  </button>
                </div>
                <div class="recent-items">
                  <div
                    v-for="s in recentSearches"
                    :key="s"
                    class="recent-item-wrapper"
                  >
                    <button class="recent-item" @click="applySuggestion(s)">
                      {{ s }}
                    </button>
                    <button
                      class="recent-delete-btn"
                      title="Remove search"
                      @click.stop.prevent="removeRecentSearch(s)"
                    >
                      <span class="vpi-delete delete-icon-mini" />
                    </button>
                  </div>
                </div>
              </li>
              <li
                v-if="
                  !isSearching &&
                  (results.length < totalResultsCount || mayHaveMore)
                "
                key="show-more"
                class="show-more-item"
              >
                <button
                  class="show-more-btn"
                  @click="resultLimit += RESULTS_PAGE_SIZE"
                >
                  Show more results
                  <template
                    v-if="!mayHaveMore && totalResultsCount > results.length"
                  >
                    ({{ totalResultsCount - results.length }} remaining)
                  </template>
                </button>
              </li>
            </TransitionGroup>
          </ul>

          <div class="search-keyboard-shortcuts">
            <span>
              <kbd
                :aria-label="translate('modal.footer.navigateUpKeyAriaLabel')"
              >
                <span class="vpi-arrow-up navigate-icon" />
              </kbd>
              <kbd
                :aria-label="translate('modal.footer.navigateDownKeyAriaLabel')"
              >
                <span class="vpi-arrow-down navigate-icon" />
              </kbd>
              {{ translate('modal.footer.navigateText') }}
            </span>
            <span>
              <kbd :aria-label="translate('modal.footer.selectKeyAriaLabel')">
                <span class="vpi-corner-down-left navigate-icon" />
              </kbd>
              {{ translate('modal.footer.selectText') }}
            </span>
            <span v-if="showDetailedList">
              <kbd>
                <span class="vpi-arrow-left navigate-icon" />
              </kbd>
              <kbd>
                <span class="vpi-arrow-right navigate-icon" />
              </kbd>
              {{ customTitles.cycleMatches }}
            </span>
            <span>
              <kbd :aria-label="translate('modal.footer.closeKeyAriaLabel')">
                esc
              </kbd>
              {{ translate('modal.footer.closeText') }}
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.VPLocalSearchBox {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: flex;
}
.backdrop {
  position: absolute;
  inset: 0;
  background: var(--vp-backdrop-bg-color);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  will-change: opacity;
}

.shell {
  position: relative;
  padding: 12px;
  margin: 64px auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--vp-local-search-bg);
  width: min(100vw - 60px, 900px);
  height: min-content;
  max-height: min(100vh - 128px, 900px);
  border-radius: 6px;
  will-change: transform, opacity;
}

@media (max-width: 767px) {
  .shell {
    margin: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    max-height: none;
    border-radius: 0;
    overflow: hidden;
  }
}

.search-bar {
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  cursor: text;
}

@media (max-width: 767px) {
  .search-bar {
    padding: 0 8px;
  }
}

.search-bar:focus-within {
  border-color: var(--vp-c-brand-1);
}

.local-search-icon {
  display: block;
  font-size: 18px;
}

.navigate-icon {
  display: block;
  font-size: 14px;
}

.search-icon {
  margin: 8px;
}

@media (max-width: 767px) {
  .search-icon {
    display: none;
  }
}

.search-input {
  padding: 6px 12px;
  font-size: inherit;
  width: 100%;
}

.search-input::-webkit-search-cancel-button,
.search-input::-webkit-search-decoration,
.search-input::-webkit-search-results-button,
.search-input::-webkit-search-results-decoration {
  display: none;
}

/* Custom Feature: Match navigation controls overlay */
.result-item {
  position: relative;
}

.excerpt-actions {
  position: absolute;
  bottom: 4px;
  right: 4px;
  z-index: 2000;
  cursor: default;
  display: flex;
  align-items: center;
  gap: 4px;
  background-color: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  padding: 2px 4px;
  box-shadow: var(--vp-shadow-1);
  transition:
    gap 0.2s,
    padding 0.2s;
}

.match-nav-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  color: var(--vp-c-text-2);
  transition:
    color 0.2s,
    background-color 0.2s,
    transform 0.1s ease;
  cursor: pointer;
}

.match-nav-button::before {
  content: '';
  position: absolute;
  top: -8px;
  left: -8px;
  right: -8px;
  bottom: -8px;
}

.match-nav-button:active {
  transform: scale(0.92);
}

@media (any-pointer: coarse) {
  .excerpt-actions {
    gap: 12px;
    padding: 4px 8px;
  }
  .match-nav-button {
    width: 32px;
    height: 32px;
  }
  .match-count {
    font-size: 13px;
  }
}

.match-nav-button:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-bg-soft);
}

.match-count {
  font-size: 11px;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
  user-select: none;
  min-width: 24px;
  text-align: center;
}

@media (max-width: 767px) {
  .search-input {
    padding: 6px 4px;
  }
}

.search-actions {
  display: flex;
  gap: 4px;
}

@media (any-pointer: coarse) {
  .search-actions {
    gap: 8px;
  }
}

@media (min-width: 769px) {
  .search-actions.before {
    display: none;
  }
}

.search-actions button {
  padding: 8px;
}

.search-actions button:not([disabled]):hover,
.toggle-layout-button.detailed-list,
.toggle-fuzzy-button.fuzzy-active,
.toggle-url-button.url-active {
  color: var(--vp-c-brand-1);
}

.search-actions button.clear-button:disabled {
  opacity: 0.37;
}

.search-keyboard-shortcuts {
  font-size: 0.8rem;
  opacity: 75%;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  line-height: 14px;
}

.search-keyboard-shortcuts span {
  display: flex;
  align-items: center;
  gap: 4px;
}

@media (max-width: 767px) {
  .search-keyboard-shortcuts {
    display: none;
  }
}

.search-keyboard-shortcuts kbd {
  background: rgba(128, 128, 128, 0.1);
  border-radius: 4px;
  padding: 3px 6px;
  min-width: 24px;
  display: inline-block;
  text-align: center;
  vertical-align: middle;
  border: 1px solid rgba(128, 128, 128, 0.15);
  box-shadow: 0 2px 2px 0 rgba(0, 0, 0, 0.1);
}

.results {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  outline: none;
  gap: 6px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.result {
  position: relative;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 4px;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
  line-height: 1rem;
  border: solid 2px var(--vp-local-search-result-border);
  outline: none;
}

.result-link {
  color: inherit;
  text-decoration: none;
}

.result-link::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
}

/* Match navigation controls fade/slide transition */
.match-actions-fade-enter-active,
.match-actions-fade-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.match-actions-fade-enter-from,
.match-actions-fade-leave-to {
  opacity: 0;
  transform: translateY(2px) scale(0.98);
}

.result > div {
  margin: 12px;
  width: 100%;
  overflow: hidden;
}

@media (max-width: 767px) {
  .result > div {
    margin: 8px;
  }
}

.titles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  position: relative;
  z-index: 1001;
  padding: 2px 0;
}

.title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.title-icon + .title .text {
  font-weight: 600;
  border-bottom: 1px solid var(--vp-c-brand-1);
}

.title.main {
  font-weight: 500;
}

.title-icon {
  opacity: 0.5;
  font-weight: 500;
  color: var(--vp-c-brand-1);
}

.title svg {
  opacity: 0.5;
}

.result.selected {
  --vp-local-search-result-bg: var(--vp-local-search-result-selected-bg);
  border-color: var(--vp-local-search-result-selected-border);
}

.excerpt-wrapper {
  position: relative;
}

.excerpt {
  pointer-events: none;
  max-height: 140px;
  overflow: hidden;
  position: relative;
  margin-top: 4px;
  will-change: opacity;
  transform: translateZ(0);
}

@media (hover: hover) {
  .excerpt {
    opacity: 0.8;
  }
}

.result.selected .excerpt {
  opacity: 1;
}

/*
 * Scale the entire excerpt down by setting the root font-size only,
 * then re-assert the page formatting (bold, code, links, lists) with
 * enough contrast to stay readable at preview size and through the
 * opacity used for unselected results.
 */
.excerpt {
  font-size: 14.5px;
  line-height: 1.6;
}

.excerpt :deep(strong),
.excerpt :deep(b) {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.excerpt :deep(em),
.excerpt :deep(i) {
  font-style: italic;
}

.excerpt :deep(a) {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-style: solid;
  text-decoration-color: transparent;
}

.excerpt :deep(strong a),
.excerpt :deep(a strong),
.excerpt :deep(b a),
.excerpt :deep(a b) {
  font-weight: bold;
}

.excerpt :deep(p) {
  margin: 0.5em 0;
}

.excerpt :deep(ul),
.excerpt :deep(ol) {
  margin: 0.5em 0;
  padding-inline-start: 1.5em;
}

.excerpt :deep(ul) {
  list-style-type: disc;
}

.excerpt :deep(ol) {
  list-style-type: decimal;
}

.excerpt :deep(li) {
  display: list-item;
  margin: 0.5em 0;
}

.excerpt :deep(:not(pre) > code) {
  background-color: var(--vp-c-bg-alt);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.9em;
  border: 1px solid var(--vp-c-divider);
}

.excerpt :deep(blockquote) {
  border-left: 3px solid var(--vp-c-divider);
  padding-left: 0.8em;
  margin: 0.5em 0;
  color: var(--vp-c-text-2);
}

/* Highlight styles - default state */
.excerpt :deep(mark) {
  background-color: var(--vp-local-search-highlight-bg);
  color: var(--vp-local-search-highlight-text);
  border-radius: 2px;
  padding: 0 2px;
  margin: 0 -2px;
  transition: background-color 0.2s;
}

.titles :deep(mark) {
  background-color: var(--vp-local-search-highlight-bg);
  color: var(--vp-local-search-highlight-text);
  border-radius: 2px;
  padding: 0;
  margin: 0;
  transition: background-color 0.2s;
}

/* Currently focused search highlight */
.excerpt :deep(mark.current) {
  background-color: var(--vp-focus-highlight-bg);
  color: black;
  font-weight: bold;
}

.excerpt :deep(.vp-code-group) .tabs {
  display: none;
}

.excerpt :deep(.vp-code-group) div[class*='language-'] {
  border-radius: 8px !important;
}

.excerpt-gradient-bottom {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 100%;
  height: 8px;
  background: linear-gradient(transparent, var(--vp-local-search-result-bg));
  z-index: 1000;
}

.excerpt-gradient-top {
  position: absolute;
  top: -1px;
  left: 0;
  width: 100%;
  height: 8px;
  background: linear-gradient(var(--vp-local-search-result-bg), transparent);
  z-index: 1000;
}

.result.selected .titles,
.result.selected .title-icon {
  color: var(--vp-c-brand-1) !important;
}

.no-results {
  font-size: 0.9rem;
  text-align: center;
  padding: 12px;
}

svg {
  flex: none;
}

.vp-local-search-enter-from .backdrop,
.vp-local-search-leave-to .backdrop {
  opacity: 0;
}

.vp-local-search-enter-active .backdrop {
  transition: opacity 0.15s ease-out;
}

.vp-local-search-leave-active .backdrop {
  transition: opacity 0.1s ease-in;
}

@keyframes vp-shell-enter {
  from {
    opacity: 0;
    transform: scale(0.975) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.vp-local-search-enter-active .shell {
  animation: vp-shell-enter 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.vp-local-search-leave-active .shell {
  animation: vp-shell-enter 0.1s cubic-bezier(0.16, 1, 0.3, 1) reverse both;
}

.searching {
  display: flex;
  justify-content: center;
  padding: 16px;
}

.vp-search-spinner {
  display: block;
  width: 18px;
  height: 18px;
  border: 2px solid var(--vp-c-divider);
  border-top-color: var(--vp-c-brand-1);
  border-radius: 50%;
  animation: vp-spin 0.6s linear infinite;
}

@keyframes vp-spin {
  to {
    transform: rotate(360deg);
  }
}

.no-results-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 0.8rem;
}

.try-fuzzy-btn,
.suggestion-btn {
  padding: 2px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  color: var(--vp-c-brand-1);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.try-fuzzy-btn:hover,
.suggestion-btn:hover {
  background-color: var(--vp-c-bg-soft);
}

.did-you-mean {
  color: var(--vp-c-text-2);
}

.recent-searches {
  padding: 8px 12px;
}

.recent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.clear-all-btn {
  font-size: 0.75rem;
  color: var(--vp-c-brand-1);
  opacity: 0.75;
  cursor: pointer;
  transition: opacity 0.15s;
  background: transparent;
  border: none;
}

.clear-all-btn:hover {
  opacity: 1;
}

.recent-label {
  display: block;
  font-size: 0.75rem;
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.recent-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.recent-item-wrapper {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background-color: transparent;
  transition: background-color 0.15s;
}

.recent-item-wrapper:hover {
  background-color: var(--vp-c-bg-soft);
}

.recent-item-wrapper .recent-item {
  border: none;
  background: transparent;
  padding: 3px 6px 3px 10px;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: color 0.15s;
}

.recent-item-wrapper:hover .recent-item {
  color: var(--vp-c-text-1);
}

.recent-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 3px 8px 3px 4px;
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: color 0.15s;
}

.recent-delete-btn:hover {
  color: var(--vp-c-danger-1);
}

.delete-icon-mini {
  font-size: 11px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

.results-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-top: -4px;
  padding: 4px 4px 10px;
  border-bottom: 1px dashed var(--vp-c-divider);
}

.results-info-text {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  padding-left: 8px;
}

/* Custom Feature: Category filter chips */
.category-filters {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  padding: 0 4px 2px;
  margin-top: -6px;
}

@supports not selector(::-moz-progress-bar) {
  .category-filters {
    margin-bottom: -6px;
  }

  .category-filters::-webkit-scrollbar {
    height: 8px;
  }

  .category-filters::-webkit-scrollbar-track {
    background: transparent;
  }

  .category-filters::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background-color: var(--vp-c-text-3);
    background-clip: content-box;
  }

  .category-filters::-webkit-scrollbar-thumb:hover {
    background-color: var(--vp-c-text-2);
  }
}

@supports selector(::-moz-progress-bar) {
  .category-filters {
    padding-bottom: 8px;
    margin-bottom: -8px;
    scrollbar-color: var(--vp-c-text-3) transparent;
  }

  .category-filters:hover {
    scrollbar-color: var(--vp-c-text-2) transparent;
  }
}

.category-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
  background-color: var(--vp-local-search-bg);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color 0.2s,
    background-color 0.2s,
    border-color 0.2s;
}

.category-chip:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-bg-soft);
}

.category-chip.active {
  color: var(--vp-c-brand-1);
  background-color: var(--vp-c-bg-soft);
  border-color: color-mix(
    in srgb,
    var(--vp-c-brand-1) 35%,
    var(--vp-c-divider)
  );
}

.chip-count {
  font-size: 0.7rem;
  font-family: var(--vp-font-family-mono);
  opacity: 0.7;
}

.no-results-category {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toggle-layout-button {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
  background-color: var(--vp-local-search-bg);
  transition:
    color 0.2s,
    background-color 0.2s,
    border-color 0.2s;
}

.toggle-layout-icon {
  display: block;
  font-size: 14px;
  flex-shrink: 0;
}

.toggle-layout-label {
  line-height: 1;
  white-space: nowrap;
}

.toggle-layout-button:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-bg-soft);
}

.toggle-layout-button.detailed-list {
  color: var(--vp-c-brand-1);
  background-color: var(--vp-c-bg-soft);
  border-color: color-mix(
    in srgb,
    var(--vp-c-brand-1) 35%,
    var(--vp-c-divider)
  );
}

.show-more-item {
  text-align: center;
  padding: 6px;
}

.show-more-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  font-size: 0.8rem;
  color: var(--vp-c-brand-1);
  opacity: 0.75;
  padding: 0 12px;
  border-radius: 4px;
  transition:
    opacity 0.15s,
    background-color 0.15s;
}

.show-more-btn:hover {
  opacity: 1;
  background-color: var(--vp-c-bg-soft);
}

/* Custom Feature: Fuzzy search toggle button styling */
.toggle-fuzzy-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 16px;
  font-weight: bold;
  border-radius: 4px;
  transition: all 0.2s;
}

.toggle-fuzzy-button .fuzzy-icon,
.toggle-fuzzy-button .exact-icon {
  font-size: 18px;
  font-weight: bold;
  line-height: 1;
}

.toggle-fuzzy-button:hover {
  background: var(--vp-c-bg-soft);
}

.toggle-fuzzy-button.fuzzy-active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

/* Custom Feature: URL search toggle button styling */
.toggle-url-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 16px;
  font-weight: bold;
  border-radius: 4px;
  transition: all 0.2s;
}

.toggle-url-button .url-icon {
  width: 18px;
  height: 18px;
}

.toggle-url-button:hover {
  background: var(--vp-c-bg-soft);
}

.toggle-url-button.url-active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

.toggle-url-button.url-auto:not(.url-active) {
  color: var(--vp-c-brand-1);
  opacity: 0.6;
}

.result-list-enter-active,
.result-list-leave-active {
  transition: opacity 0.15s ease;
}
.result-list-enter-from,
.result-list-leave-to {
  opacity: 0;
}
</style>
