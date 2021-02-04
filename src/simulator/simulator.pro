# TODO: Simplify this file removing unnecessary INCLUDEPATH/HEADERS and so on
QT       += core gui widgets opengl

TARGET = simulator
TEMPLATE = app

INCLUDEPATH += $$PWD/simulator/ \
               $$PWD/../../third-party

HEADERS  += \
    ca_dll.h \
    $$PWD/../../third-party/imgui/imgui.h \
    $$PWD/../../third-party/imgui/imgui_impl_glfw.h \
    $$PWD/../../third-party/imgui/imconfig.h \
    $$PWD/../../third-party/imgui/imgui_internal.h \
    $$PWD/../../third-party/imgui/stb_textedit.h \
    $$PWD/../../third-party/imgui/stb_rect_pack.h \
    $$PWD/../../third-party/imgui/stb_truetype.h
    $$PWD/../../third-party/glfw/glfw3native.h \

SOURCES += \
  main.cpp \
  ca_dll.cpp \
  $$PWD/../../third-party/imgui/imgui.cpp \
  $$PWD/../../third-party/imgui/imgui_impl_glfw.cpp \
  $$PWD/../../third-party/imgui/imgui_draw.cpp

LIBS += -L"$$PWD/../../third-party/glfw/" -lglfw3 -lopengl32 -lgdi32
